# Otimização de carga do Supabase e do aplicativo

Data local: 16/10/2026. Leituras finais em 17/10 UTC. Projeto autorizado: `wnicimkmzswksaqdtgdv`. Investigação dividida entre três agentes e integração principal. Sem testes automatizados, reprodução ou navegação no aplicativo; Safari utilizado para a autorização administrativa solicitada pelo usuário.

## Diagnóstico demonstrado

As capturas distinguem CPU de 98% de **Logs Query**: 75,246 GB consultados em um dia e 83,41 GB no ciclo da organização. Segundo a [documentação oficial](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query), essa métrica soma bytes varridos ao consultar logs, inclusive pelo painel/API/CLI; não mede tamanho do banco nem transferência do catálogo. A captura de ingestão indica 0,259 GB. Não foi identificado o autor de cada consulta histórica. Esta investigação priorizou estatísticas PostgreSQL e não usou Logs Explorer ou `query_logs`.

Às 23:55:52 UTC, uma leitura de atividade encontrou a limpeza de gerações ativa havia 107,7 segundos. Os contadores cumulativos posteriores localizaram os seguintes custos; tempos de execução não equivalem a percentuais de CPU, e a janela de acumulação não foi determinada:

| Rotina | Chamadas | Média | Máximo |
| --- | ---: | ---: | ---: |
| Limpeza de gerações | 38 | 28,232 s | 115,873 s |
| Relógio da grade TV | 44 | 17,874 s | 95,964 s |
| Disparo do coletor | 45 | 5,096 s | 14,476 s |
| Agregação de métricas de marcadores | 2 | 66,122 s | 107,533 s |
| Limpeza de progresso adulto | 7 | 12,270 s | 19,124 s |

Outras estatísticas identificaram enfileiramento com média de 2,674 s e agendamento dos marcadores com 4,696 s. Os crons explicam atividade do próprio projeto sem espectadores. Contagens do painel e desses serviços não demonstram tráfego de usuários na aplicação.

## Alterações instaladas no banco

Nove migrations tiveram resposta de aplicação e leitura posterior das definições/configurações. Seus arquivos locais foram alinhados às versões efetivamente registradas pela Management API:

- [20261017000049](../supabase/migrations/20261017000049_arkhen_catalog_cleanup_generation_cursor.sql): limpeza procura gerações por cursor privado/índices, verifica proteções antes das linhas e limita o lote global. O antigo `LIMIT 500` limitava exclusões, permitindo uma busca completa sem vítimas. Conserva geração publicada, snapshot atual, staging, leases e retenção de um dia.
- [20261017000141](../supabase/migrations/20261017000141_arkhen_idle_collector_and_bounded_home.sql): coletor verifica trabalho elegível antes de Vault/HTTP; backfill Home aceita o contrato antigo, mas altera no máximo 50 linhas por transação. Uma leitura limitada confirmou **zero identidades pendentes** nas gerações visíveis; seu cron permanece inativo e o trigger continua cobrindo novos metadados.
- [20261017002040](../supabase/migrations/20261017002040_arkhen_tv_guide_incremental_windows.sql): TV reaproveita janelas por canal até sua próxima fronteira. Sobreposições/lacunas usam todos os inícios/fins relevantes. Snapshot/geração novos reconstruem a projeção. Mantém duas visibilidades, cache compartilhado, DTO, relógio e cálculo de progresso no servidor. A primeira projeção precisa preencher as fronteiras privadas.
- [20261017002112](../supabase/migrations/20261017002112_arkhen_bounded_privacy_sweep_and_marker_lease.sql): limpeza de privacidade examina no máximo 50 progressos por página, em vez de limitar somente as vítimas. Cursor privado, regras de classificação, RLS e trigger de escrita são preservados. O agendador evita HTTP quando existe lease válido; isso não elimina seus disparos normais a cada dois minutos.
- [20261017002125](../supabase/migrations/20261017002125_arkhen_marker_metrics_relevant_revision.sql): mudanças nos campos contados registram transações pendentes. Sem mudanças, não se agrega toda a fonte. Agregação e publicação global continuam atômicas; commits concorrentes ficam pendentes. Triggers com transition tables ainda têm custo proporcional ao lote alterado.
- [20261017002425](../supabase/migrations/20261017002425_arkhen_scheduler_jit_and_cron_budgets.sql): JIT desligado nas pequenas rotinas de agendamento, preservando corpos; prazos estabelecidos antes do SELECT de métricas e privacidade.
- [20261017003447](../supabase/migrations/20261017003447_arkhen_marker_metrics_atomic_batches.sql): substitui a agregação integral que ainda expirou por até 128 títulos/rodada, com busca indexada por IMDb e orçamento cooperativo de 2 s entre unidades. Bootstrap e resultados parciais ficam privados. A publicação completa e o timestamp global mudam numa única instrução quando a descoberta e todas as pendências terminam. ACK exato por IMDb/transação e por evento global/revisão preserva commits concorrentes e TRUNCATE repetido. Deadline externo reduzido para 8 s. O bootstrap inicial exige vários ciclos e mantém o snapshot público anterior; uma unidade IMDb excepcionalmente grande ainda pode alcançar o deadline.
- [20261017003646](../supabase/migrations/20261017003646_arkhen_catalog_cleanup_separate_seek_and_tid_batches.sql): uma geração/fase por chamada; descoberta é persistida antes dos guards. Rotação por minuto UTC continua mesmo se uma tabela expirar. Arrays de até 50 TIDs bloqueados são consumidos na mesma transação, com teto global 500 e orçamento cooperativo de 1 s. Busca de idade em geração recente ainda pode examinar mais linhas que o lote; não se declara que apenas 50 linhas são examinadas nem que a capacidade nominal foi medida.
- [20261017003830](../supabase/migrations/20261017003830_arkhen_tv_guide_channel_local_windows.sql): a reconstrução da TV também apresentou um timeout posterior e um `job startup timeout`. O cálculo dos canais vencidos passou a materializar/ordenar uma lista por canal por LATERAL/PK, conservando seleção, empates, fronteiras e publicação das duas visibilidades. Remove as três ordenações globais com descrições; não foi medido o tempo de cada nó do plano, portanto a causa específica do timeout não é atribuída a um nó.

A contenção da limpeza foi confirmada apesar de o envio inicial expirar. Uma tentativa de cancelamento da sessão observada não teve sucesso confirmado. TV teve uma janela de pausa para DDL depois de um conflito de lock; não foi reiniciado o projeto Supabase. Depois do readback, a [retomada guardada](../supabase/operations/resume-bounded-catalog-maintenance.sql) conservou a TV por minuto e espaçou a limpeza para cinco minutos.

Estado da segunda retomada, conferido às 00:38:40 UTC:

| Job | Ativo | Cadência | Prazo externo |
| --- | --- | --- | --- |
| Limpeza de gerações | Sim | 1 minuto, tabelas rotativas | 3 s |
| Grade TV | Sim | 1 minuto | 20 s |
| Métricas de marcadores | Sim | 5 minutos, minuto 2/7/12… | 8 s |
| Privacidade de progresso | Sim | 5 minutos, minuto 3/8/13… | 8 s |
| Backfill Home | Não | Definição original preservada | — |

`SET statement_timeout` dentro de uma função não foi tratado como garantia de interrupção da chamada externa; os comandos agendados estabelecem o prazo antes do SELECT. Não houve aumento de compute, plano, timeout global, nem remoção das proteções de dados publicados.

Os primeiros ciclos naturais impediram encerrar a investigação nessa etapa: às 00:25, limpeza e métricas atingiram, respectivamente, os prazos de 3 s e 45 s. O contexto PostgreSQL localizou a limpeza na expressão de proteção de gerações, antes do DELETE; seu seek de arte usava `Index Only Scan`. O plano de todos os guards estimou custo baixo de 13,69, sem demonstrar um scan isolado caro. Portanto, o limite de lote sozinho não demonstrou solução. Ambos os jobs foram pausados novamente às 00:30, com readback, para a correção incremental. A [segunda retomada guardada](../supabase/operations/resume-incremental-maintenance.sql) restaurou a cadência original de um minuto da limpeza para sustentar escoamento com unidades curtas e distribuiu métricas/privacidade em minutos diferentes. A capacidade de limpeza depende de linhas removidas e duração, não só do teto nominal.

Entre 00:23:54 e 00:26:50 UTC, as diferenças dos contadores mostraram três enfileiramentos com média de 0,576 s e três disparos do coletor com média de 0,604 s. Três chamadas TV somaram média de 4,837 s; os ciclos individuais seguintes à instalação variaram de 2,544 a 9,044 s. A privacidade concluiu um ciclo em 7,460 s de parede. A janela é pequena e mistura condições de carga diferentes; essas durações não certificam uma porcentagem de CPU nem a conclusão de todos os trabalhos.

A segunda limpeza concluiu sua primeira descoberta natural às 00:38 em 0,840 s, persistindo a fase de categorias. Isso comprova avanço do cursor, não exclusão de uma geração aposentada. Os readbacks das três definições finais conferiram seus hashes, e a TV permanece com prazo externo 20 s.

## Workers publicados

O coletor `arkhen-catalog-sync` passou da versão 9 para **10**; `series-markers-sync`, da 6 para **7**. A listagem administrativa confirmou ambos `ACTIVE`, com a autenticação própria por segredo e a configuração `verify_jwt=false` anterior preservadas. A alteração remove continuações automáticas a cada 11 segundos; aceleração exige opt-in explícito. Descoberta esgotada e retenção usam intervalo de 15 minutos; sementes curadas, um dia. Cursores, leases, snapshots e cron continuam retomando trabalho pendente.

Os arquivos remotos recuperados coincidiam com a base versionada antes das três alterações. O download completo da CLI recusou dependências fora de `supabase/functions`; o deploy pela API incluiu as dependências locais referenciadas e sua conclusão foi conferida pela versão/hash do bundle. Não foram invocados os workers como teste.

## Aplicativo e backend local

`web/cloud-library.js` aplica linhas Realtime e respostas de upsert sem reler quatro tabelas a cada progresso/preferência; reconexão reconcilia dados perdidos. Empates de timestamp respeitam eventos distintos e ecos idênticos são deduplicados. A outbox agrupa envios simultâneos. Foco saudável não refaz bootstrap; falhas usam espera progressiva e aba oculta suspende retries automáticos.

Catálogos têm atualização diária agrupada e backoff de 1–15 minutos por domínio após falha/incompletude. Publicações pendentes e EPG aguardam visibilidade. A Home deixa de iniciar projeções por progresso enquanto o player/outra tela está aberto. `lib/cloud-runtime.mjs` agrupa pedidos de atualização por partição/tipo por um minuto; enfileirar não apaga snapshots nem caches dos outros domínios. Leituras completas têm cache curto e falhas têm cooldown de 30 s, inclusive em reload. Snapshot antigo não é apresentado como refresh bem-sucedido, preservando a idade do cache diário.

Essas alterações foram revistas estaticamente e passaram em `node --check`; não houve nova publicação do site nesta rodada. Alterações anteriores no workspace foram preservadas. Redução real de requisições do cliente depende de carregar o código atualizado; schema instalado e worker ativo não comprovam experiência do navegador ou mídia.

## Verificação e operação

Os scripts de [operações](../supabase/operations/) fazem inspeções limitadas e distinguem leitura, pausa e retomada. O comando `inspect` de `tools/supabase-project.mjs` usa a rota oficial `/database/query/read-only`; `query` explicita escrita. A rota de leitura respondeu durante timeouts da rota administrativa. Não se atribui toda a instabilidade a esse transporte nem se declara CPU recuperada apenas pela saúde administrativa.

As observações posteriores usam somente execuções naturais dos crons, sem disparar jobs para teste. A redução da CPU precisa de uma série temporal comparável; nenhuma porcentagem final foi certificada. As consultas históricas de logs não foram atribuídas a um agente, usuário ou cliente sem evidência.

Às 00:40 UTC, TV concluiu um ciclo da definição final em 1,064 s; privacidade concluiu o ciclo anterior em 1,584 s. Limpeza teve duas descobertas confirmadas, em 0,840 e 0,828 s. Ainda não havia execução observada da nova métrica incremental. As inspeções compostas posteriores voltaram a expirar, inclusive com 57014 no orçamento de 5 s; portanto, não foi certificado o avanço do primeiro lote de métricas, a fase de exclusão da limpeza ou recuperação sustentada. A pedido posterior do usuário, a prioridade passou à engenharia reversa/documentação do APK antes de outros ajustes. Não se confunde essa interrupção da medição com conclusão do incidente.

Fontes: migrations citadas; `lib/cloud-runtime.mjs`; `web/{cloud-library,cloud-app-bridge,app}.js`; `web/inicio/tanstack-query.js`; `web/tv/{tanstack-query,canais/lista}.js`; `web/sistema/catalogo/realtime.js`; handlers/pipeline em `supabase/functions/`; [inspeção PostgreSQL](https://supabase.com/docs/guides/observability/inspect), [CPU](https://supabase.com/docs/guides/troubleshooting/high-cpu-usage), [rota de leitura](https://supabase.com/docs/reference/api/v1-read-only-query).
