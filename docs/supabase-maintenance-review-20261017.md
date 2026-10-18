# Manutenção Supabase: descoberta limitada e progresso das métricas

Data: 16/17 de outubro de 2026. Projeto autorizado: `wnicimkmzswksaqdtgdv`. Esta frente alterou SQL e o worker de marcadores fora do domínio TV/EPG. Nenhum teste automatizado, navegador, mídia ou execução manual de job foi realizado. As leituras remotas abaixo foram coordenadas pelo agente principal; os arquivos locais, por si, não certificam aplicação remota.

## Evidência que orientou a alteração

O [relatório anterior](supabase-load-optimization-20261016.md) documenta os timeouts, as nove migrations aplicadas e a falta de comprovação do bootstrap das métricas. A leitura inicial desta etapa do singleton mostrou `metrics_seeded=true`, ambas as descobertas incompletas, cursores ainda não iniciados, `completed_units=1` e `last_published_at=null`. As execuções naturais de métricas às 01:02 e 01:07 concluíram em aproximadamente 6,156 s e 4,956 s; a das 01:12 falhou em 10,289 s com classificação `JOB_STARTUP_TIMEOUT`. Isso distingue falha de inicialização de cancelamento dentro da função.

No código instalado anteriormente, `started` era capturado antes dos locks, leitura de invalidações e preparação dos primeiros statements. Os loops verificavam os limites de 500 ms / 2 s **antes da primeira unidade**. Assim, tempo de preparação/inicialização podia consumir a janela de trabalho e permitir várias chamadas concluídas sem avançar a descoberta. O clock observado é compatível com esse mecanismo; não foi medido isoladamente o custo de cada preparação.

O enfileiramento também consulta jobs recentes pelo histórico terminal. O readback de metadados estimou apenas 400 linhas em `cache_jobs`; o EXPLAIN dessa procura mostrou `Seq Scan` com custo estimado de aproximadamente 20. Não há evidência suficiente para adicionar um índice nessa tabela nesta etapa. Os índices existentes e seus leases foram preservados.

## Progresso das métricas sem mudar a publicação

A migration [20261017011924](../supabase/migrations/20261017011924_arkhen_marker_metrics_phase_progress.sql) inicia o orçamento de cada fase imediatamente antes dela. A primeira busca indexada e a primeira unidade IMDb são tentadas antes da condição cooperativa de saída. Uma coluna privada `discovery_turn` alterna a fonte de descoberta; fontes já completas são puladas. O teto de 128 unidades, o orçamento de descoberta de 500 ms, o de processamento de 2 s e o prazo externo de 8 s permanecem. O orçamento cooperativo não interrompe uma unidade em andamento; uma unidade ou preparação excepcional ainda pode alcançar o deadline e reverter a transação.

Enquanto a descoberta estiver incompleta, a função persiste o clock e retorna antes do statement de publicação. Isso evita preparar um statement grande cujo gate obrigatoriamente falharia naquela rodada. Essa saída não publica métricas parciais nem altera o timestamp público.

A revisão adversarial preservou estas propriedades da [publicação incremental anterior](../supabase/migrations/20261017003447_arkhen_marker_metrics_atomic_batches.sql):

- Deltas e bootstrap ficam em tabelas privadas, com RLS e sem grants para `anon`/`authenticated`.
- A agregação por IMDb captura os writers visíveis antes de ler as fontes e reconhece exatamente `(imdb_id,writer_xid)`. Um commit posterior permanece pendente; ordem de txid não é tratada como ordem de commit.
- Invalidação global inclui a revisão do evento, conservando TRUNCATE repetido na mesma transação. O reset preserva invalidações individuais que poderiam ficar atrás do cursor.
- Gate, publicação das contagens, remoção de títulos extintos, checkpoint público e ACK compartilham um único statement/transação. O resultado público anterior continua disponível até a publicação completa. O timeout reverte a rodada inteira.
- A nova migration conserva integralmente o statement de publicação e os ACKs; altera apenas fase, alternância e saída antecipada quando a descoberta ainda impede publicar.

Essas propriedades foram conferidas estaticamente. A integração principal confirmou o schema por hash/grants; o checkpoint natural às 01:26:21 UTC passou de uma para cinco unidades e iniciou o cursor de marcadores. Ainda faltam a conclusão das duas fontes e `last_published_at`; não se declara bootstrap concluído pela instalação da função ou pelo primeiro avanço.

## Descoberta de séries por página examinada

A RPC antiga limita até 500 **mudanças** depois do join do catálogo visível com as identidades. Sem pendências, ela pode percorrer toda a geração para concluir que nenhuma linha mudou. A migration [20261017012209](../supabase/migrations/20261017012209_arkhen_marker_discovery_bounded_pages.sql) cria a RPC de serviço `arkhen_marker_discover_batch` e cursor privado por provedor/escopo/tipo, contendo a geração e a última chave processada. A RPC antiga continua intacta para compatibilidade.

A busca limita primeiro uma página ordenada pela PK `(provider_key,scope_hash,media_type,generation_id,media_id)`. Com o argumento padrão, materializa no máximo 500 candidatas: até 499 para processamento e uma sonda que determina a existência real de continuação. A comparação com identidades e os upserts ficam restritos à página. Linhas inativas também avançam o cursor; elas não provocam uma busca irrestrita para completar um lote de linhas ativas. O seek usa limite inferior de chave e exclusão da âncora, sem `OFFSET` nem `OR parâmetro IS NULL`. A primeira página também admite uma chave textual vazia válida no schema.

`changed` contabiliza somente alterações reais; `scanned` descreve candidatas materializadas e inclui a sonda; `hasMore` distingue pendência de uma página sem mudanças. Esses tetos não contam versões mortas MVCC, filtros internos do índice ou tempo de I/O, portanto não equivalem a um limite físico absoluto de leituras de página/disco.

Geração concluída aguarda 15 minutos antes de outra varredura. Uma geração nova torna a partição elegível no próximo ciclo do worker, independentemente desse intervalo. A repetição após 15 minutos preserva a recuperação eventual de identidades removidas ou mudanças feitas na mesma geração; não se presume imutabilidade eterna dos dados publicados. A verificação da geração é repetida no statement da página: uma troca concorrente não transforma staging de outra geração em descoberta pública. Página, upserts e cursor participam da mesma transação; falha não avança o cursor sobre alterações não persistidas.

O [store](../supabase/functions/series-markers-sync/store.mjs) adiciona `discoverBatch`, conservando `discover`. O [pipeline](../supabase/functions/series-markers-sync/pipeline.mjs) usa a RPC paginada a cada execução, para detectar gerações novas pelo pequeno registro/cursor. Quando a partição está concluída e dentro do intervalo, o SQL retorna sem percorrer `catalog_media`. Stores legados/injetados mantêm o contrato inteiro e o watermark anterior. A migration deve ser aplicada e conferida **antes** do deploy do worker atualizado.

Não houve alteração de lease, verificação audiovisual, classificação de marcadores, cache de conta, catálogo público, geração publicada, limpeza de progresso ou cron nesta frente. Não foi criado índice novo nem aumentado compute, prazo ou quantidade de conexões.

## Readbacks pequenos e implantação

As operações de inspeção foram separadas para não somar múltiplas contagens/scans numa só consulta sob carga:

- [inspect-maintenance-current-outcome.sql](../supabase/operations/inspect-maintenance-current-outcome.sql): três execuções naturais de métricas; classifica falha sem devolver texto bruto da mensagem.
- [inspect-maintenance-metrics-clock.sql](../supabase/operations/inspect-maintenance-metrics-clock.sql): um singleton e flags, sem contar as fontes ou filas.
- [inspect-cache-jobs-index-metadata.sql](../supabase/operations/inspect-cache-jobs-index-metadata.sql) e [explain-cache-job-recent-discovery.sql](../supabase/operations/explain-cache-job-recent-discovery.sql): metadados/estimativas e plano sem ANALYZE.
- [explain-marker-catalog-discovery.sql](../supabase/operations/explain-marker-catalog-discovery.sql): plano da seleção antiga, sem ler resultados, nomes ou JSONs.
- [readback-marker-maintenance-functions.sql](../supabase/operations/readback-marker-maintenance-functions.sql): hashes, configurações e grants das três funções.
- [readback-marker-discovery-cursor.sql](../supabase/operations/readback-marker-discovery-cursor.sql): até três cursores, omitindo provedor/escopo e IDs de títulos.

Hashes MD5 de `prosrc` para comparação com o banco, não hashes dos arquivos SQL:

| Rotina | Baseline esperado | Definição nova |
|---|---|---|
| `arkhen_refresh_marker_sync_metrics()` | `898b72f914d28fba28b2f2c3c0155650` | `969090bac09ea855cb8282e22a98a994` |
| `arkhen_marker_discover(integer)` | `48eb218ac93d994721e9d416aa6d5a21` | Inalterada |
| `arkhen_marker_discover_batch(integer)` | Ausente | `8c9fed7831dd93f59ff94217fea8c636` |

Os arquivos de migration foram criados pela CLI e revisados independentemente. A integração principal aplicou e conferiu ambas as versões indicadas nos links e publicou `series-markers-sync` versão 8 ACTIVE depois da nova RPC; o detalhe de hashes/estado está nas [evidências integradas](otimizacao-sistema-supabase-20261016.md). Os dois módulos JavaScript passaram em `node --check`. Isso é verificação de sintaxe, não teste funcional ou medição de redução de CPU.

O bundle de `series-markers-sync` usa `index.ts`, `handler.mjs`, `pipeline.mjs`, `store.mjs`, `incremental.mjs`, `metadata.mjs`, `retention.mjs`, os conectores em `conectores/` e `web/series-markers/registry.js`. A publicação deve incluir essas dependências locais atuais, preservando as reorganizações anteriores do workspace.

Referências primárias: [isolamento Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html), [CTEs com modificação de dados](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING), [locking e SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE). A documentação PostgreSQL fundamenta o raciocínio de snapshot/ACK; não substitui a observação remota do processamento.
