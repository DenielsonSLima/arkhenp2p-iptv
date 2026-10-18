# Rechecagem da saturação do banco

Data local: 16/10/2026, 22h12–22h15. Leituras remotas: 17/10/2026, 01h12–01h15 UTC. Projeto confirmado: `wnicimkmzswksaqdtgdv`.

Estado da etapa inicial (22h12–22h15): incidente aberto, somente leituras remotas. As intervenções posteriores estão registradas abaixo. Sem testes, navegador ou execução de jobs para verificação.

## Evidência atual

A captura enviada mostra CPU 95%, Disk IO 100%, memória 70% e 6/60 conexões; o cartão superior tem outra amostra (CPU 92%). A ocupação de disco de 34% é distinta do Disk IO. A imagem não permite separar CPU de usuário, sistema e espera por I/O. O [guia oficial de Disk IO](https://supabase.com/docs/guides/troubleshooting/exhaust-disk-io) explica que limitação de I/O pode aumentar CPU por espera; esse mecanismo permanece hipótese neste projeto.

O estado administrativo respondeu `ACTIVE_HEALTHY`, mas uma inspeção SQL pequena expirou com 57014. Outras leituras limitadas responderam. Nos ciclos de 01h08, 01h09, 01h10, 01h12 e 01h14, vários jobs distintos falharam juntos com `startup_timeout`. Isso localiza uma falha anterior à execução normal desses jobs, sem demonstrar sua causa sistêmica.

| Rotina | Observação natural recente |
| --- | --- |
| Grade TV | 20,008 s às 01h11; 1,568 s às 01h13; falhas de inicialização às 01h12 e 01h14 |
| Limpeza de gerações | Timeout de statement em 3,612 s às 01h11; sucesso em 0,520 s às 01h13; falhas de inicialização nos mesmos minutos |
| Privacidade | Sucesso em 2,220 s às 01h13 |
| Métricas de marcadores | Falha de inicialização às 01h12; bootstrap ainda com uma unidade concluída e 1.715 títulos pendentes às 01h14m57s |

Os contadores de `pg_stat_statements` continuam colocando TV/limpeza entre os maiores custos acumulados. A diferença entre 01h12m58s e 01h14m42s foi uma execução de TV de aproximadamente 1,553 s e uma limpeza de 0,468 s. Outra execução de TV acrescentou cerca de 11,808 s até 01h15m47s. Esses tempos variáveis não equivalem a percentuais de CPU; contadores cumulativos e falhas de inicialização devem ser avaliados separadamente.

A leitura de capacidade às 01h15m47s encontrou `jit=off`, `cron.use_background_workers=off`, `max_connections=60`, sete backends do banco e quatro clientes ociosos. Não havia outra consulta ativa nessa amostra. `max_worker_processes=6` não basta para atribuir as falhas ao limite de workers, pois o Cron usa conexões. `track_io_timing=off` torna os tempos de leitura/escrita zerados inconclusivos. Os 400.178.752 bytes temporários são acumulados, sem janela de reinicialização determinada.

## Caminhos locais que ainda geram trabalho

- O relógio TV existente renova as duas visibilidades por minuto. O cache incremental reaproveita programas, mas ainda monta/regrava o JSON completo. Fontes: migrations `20261017002040`, `20261017003830` e `20261016022551`.
- A fonte incremental de marcadores ordena os grupos pendentes para selecionar 20; o limite da saída não limita a busca. Fontes: migration `20261015120527`, `supabase/functions/series-markers-sync/incremental.mjs`.
- As métricas compartilham o início do orçamento entre descoberta e processamento. Preparação demorada pode deixar zero orçamento para títulos; `completed_units=1` também é compatível com falhas de inicialização ou rollback, portanto o contador isolado não comprova esse mecanismo. Fonte: migration `20261017003447`.

Esses são amplificadores estáticos. Não se atribui a eles toda a CPU do servidor sem correlação adicional.

## Acesso às métricas e operação concorrente

A rota oficial `/analytics/endpoints/metrics` retornou HTTP 403 para a credencial administrativa atual. A revisão automática recusou a proposta de usar uma chave `service_role` existente como alternativa; essa operação não foi executada e o caminho foi removido do código. Nenhuma chave de servidor foi revelada ou obtida. Foi solicitado ao usuário esclarecer eventual acesso `analytics:read`; não se certificou queda de CPU.

Durante a investigação surgiram migrations locais de outra autoria: `20261017011349_arkhen_tv_guide_on_demand_channels.sql` e `20261017011540_arkhen_marker_discovery_bounded_pages.sql`. A primeira estava preenchida e a segunda vazia na leitura. Esta equipe não as criou ou aplicou. Foi solicitada identificação da sessão responsável antes de qualquer mutação sobre as mesmas rotinas. A presença dos arquivos não comprova instalação remota.

## Instrumentação preparada

`tools/supabase-project.mjs metrics` consulta somente a rota oficial usando o PAT já configurado e exporta uma lista permitida de contadores de recursos, sem textos SQL ou labels arbitrários. A sintaxe JavaScript foi conferida; acesso funcional continua limitado pelo 403.

As operações `inspect-current-backend-pressure.sql`, `inspect-top-statement-pressure.sql`, `inspect-current-cron-pressure.sql`, `inspect-runtime-capacity.sql` e `inspect-pressure-counters.sql` registram somente metadados/contadores. A última usa `extensions.pg_stat_statements(false)` para dispensar o arquivo de textos SQL, conforme a [documentação PostgreSQL](https://www.postgresql.org/docs/current/pgstatstatements.html). Não executar inspeções em loop nem confundir a inspeção com recuperação.

## Intervenção autorizada após a rechecagem

O usuário determinou assumir a correção e depois solicitou análise do Astra. A revisão independente do Astra foi realizada com o modelo solicitado, sem acesso remoto ou alteração por esse revisor.

As novas capturas distinguem o gargalo: às 22h08, IOWait 94,07%, User 0,94%, System 1,69%; às 22h29, o painel apresenta IOWait 100,24%, User 1,15% e System 2,13%. Os valores acima de 100% e o ponto anterior em que todas as categorias são zero impõem cautela com amostragem/coleta; não significam capacidade física superior a 100% ou recuperação comprovada. A espera por I/O domina os pontos exibidos.

Compromisso de memória chegou a 1,96 GB contra CommitLimit de 1,2 GB, mas `Committed_AS` não é RAM física ocupada nem prova de swap. A ocupação do banco de 0,44 GB em disco provisionado de 2 GB também não mede saturação de I/O. Fontes: [relatórios](https://supabase.com/docs/guides/observability/reports), [I/O](https://supabase.com/docs/guides/troubleshooting/exhaust-disk-io), [capacidade](https://supabase.com/docs/guides/platform/compute-and-disk).

Instalações anteriores, inicialmente de outra autoria, tiveram presença remota confirmada às 01h27 UTC: TV sob demanda `20261017011816`, relógios por fase das métricas `20261017011924` e descoberta paginada `20261017012209`. Não foram reaplicadas. TV mantém janela por canal, progresso calculado em leitura e clock periódico desativado. O código local do conector também envia IDs solicitados; não houve publicação do site nesta intervenção.

Esta equipe instalou e conferiu por hash/registro:

- `20261017012807_arkhen_catalog_cleanup_bound_candidate_search.sql`: página de até 50 candidatas antes da idade; bloqueio e exclusão por TIDs na mesma transação, rechecando geração, publicação, retenção de um dia, preparação e leases. Hash final `929d205e6e9c754d0622582d77f2376f`. O limite reduz capacidade de drenagem e não certifica número de páginas físicas lidas.
- `20261017012845_arkhen_marker_metrics_skip_ineligible_publication.sql`: retorna antes da publicação quando já há títulos pendentes/sujos, conservando os checks no gate atômico. Hash final `bfab02863f54ff05241406f1a08a1728`. Não dispara agregação.

Contenção dos jobs de limpeza, métricas e clock TV foi confirmada às 01h26m55s UTC e novamente às 01h29m07s; catálogo, filas e biblioteca não foram apagados. Home continuou na pausa anterior. Os ciclos naturais dos demais jobs às 01h27–01h29 concluíram; enqueue/coletor/navegação às 01h29 duraram 0,136/0,091/0,193 s. Essa melhora não comprovou queda de IOWait, que continuou alto na captura posterior.

Às 01h33–01h34, a API de saúde retornou banco `ACTIVE_HEALTHY`, mas Auth e REST `UNHEALTHY`. A tentativa de ampliar a contenção para todos os jobs ARKHEN retornou HTTP 544; a leitura mínima às 01h34 confirmou que não persistiu. Só as três pausas anteriores estavam confirmadas. Estado dos 11 jobs, cadências e hashes dos comandos foram capturados para restauração guardada; nenhum comando ou segredo de worker foi exportado.

A consulta oficial de metadados de Edge Functions também retornou 403. Assim, não foi certificado nem republicado o bundle remoto. Foi preparada uma compatibilidade da descoberta legada para chamar uma única página e devolver o número real de mudanças; a tentativa de instalação retornou 544 antes de inicializar o histórico e não foi tratada como aplicada. A função de lote de fonte recebeu proposta revisada para limitar candidatas antes do ranking TMDB; a contagem `excluded_groups` continua sendo uma agregação da geração, portanto não há alegação de limite integral da função.

A recuperação foi orientada a um único reinício, com configurações preservadas, diante de Auth/REST indisponíveis e SQL intermitente. Reinício não recompõe orçamento de I/O; não é motivo para reinícios repetidos. `shared_buffers=224 MB` merece análise posterior na instância Nano, mas não foi alterado junto desta intervenção. Fontes: [recuperação HTTP](https://supabase.com/docs/guides/troubleshooting/http-api-issues), [buffers PostgreSQL](https://www.postgresql.org/docs/17/runtime-config-resource.html#GUC-SHARED-BUFFERS). A solicitação e a recuperação efetiva devem ser registradas separadamente.

## Contenção completa e limite da autorização de reinício

Após confirmar que o primeiro envio não persistira, a segunda pausa de todos os 11 jobs ARKHEN respondeu com sucesso. Às 01h36m10s UTC, leitura independente confirmou **zero jobs ARKHEN ativos**. Nenhum cron de sistema foi alterado. Os estados anteriores e hashes dos comandos estão registrados nas operações de pausa/restauração; a restauração não deve ativar os quatro jobs que já estavam pausados na captura.

A revisão automática rejeitou o comando de reinício antes da execução: interrupção de serviço compartilhado requer consentimento explícito para o efeito em produção. Foi solicitado ao usuário um único reinício com interrupção breve; não houve tentativa por rota, ferramenta ou credencial alternativa. O postmaster continuava com início em `2026-10-16 22:36:16 UTC`, sem reinício desta equipe.

Baseline contida às 01h36m40s: zero jobs ARKHEN ativos, nenhuma outra consulta ativa; 380.873 blocos lidos pelo banco, 400.178.752 bytes temporários e 195 arquivos temporários. Comparada à leitura das 01h15, são apenas 115 blocos adicionais e nenhum crescimento temporário. Isso enfraquece a hipótese de uma varredura/ordenação PostgreSQL contínua como causa atual do IOWait. Não exclui sincronização lenta, trabalho residual, swap, serviços internos ou problema de host/coleta.

Os contadores de I/O PostgreSQL continuam distintos de IOPS físicos completos do host. Valores de WAL/escritas cumulativos exigem comparação na mesma janela e com o mesmo reset. Comportamento do kernel e memória física não são inferidos dos campos `Committed_AS` ou tempos de I/O zerados. Novas otimizações SQL/índices foram suspensas durante essa janela para não confundir a recuperação.

Entre 01h36m40s e 01h38m57s (137 s), com zero jobs ARKHEN ativos nas duas leituras e sem outra consulta ativa, o banco leu 32 blocos (256 KiB), não criou temporários e não os ampliou. `pg_stat_io` registrou 17 escritas/14 fsyncs de checkpointer e nenhuma escrita de relações por clientes. WAL cresceu 8.778 bytes/32 registros/9 sincronizações. `wal_buffers_full` e `wal_write` cresceram 1.555/1.565; são contadores de operações e não foram convertidos em bytes físicos nem usados isoladamente para atribuir a causa. Os resets permaneceram iguais.

Na leitura de saúde ao fim dessa janela, REST passou a `ACTIVE_HEALTHY`, banco continuou saudável e Auth permaneceu `UNHEALTHY`. O volume baixo de I/O PostgreSQL enfraquece a hipótese de scan/sort contínuo nessa janela, mas não exclui latência de sincronização, swap, I/O de outros serviços ou problema do host. Não houve medição do I/O do sistema operacional nem prova de recuperação sustentada da porcentagem de CPU/IOwait.

A janela não se destina a deixar todas as atualizações desligadas. Foi preparada a restauração exata dos sete jobs originalmente ativos, mantendo as pausas de limpeza, métricas, Home e clock TV. Aplicação, readback da retomada e estado final devem ser registrados antes da entrega.

Às 01h40 UTC, o usuário autorizou explicitamente um único reinício, ciente da interrupção breve. Uma restauração transitória já enviada respondeu com sucesso; os jobs foram novamente contidos, também com resposta de sucesso, para a recuperação autorizada. A chamada oficial de reinício foi então **recusada pelo Supabase com HTTP 403: falta de `project_admin_write`**. Não houve reinício nem repetição por outro mecanismo/credencial. O impedimento de autorização automática inicial foi superado pelo consentimento; o impedimento atual é a permissão real da credencial na API.

Foi solicitado que o usuário acione um único `Restart project` em Settings/General do projeto já aberto. Enquanto essa ação está pendente, todos os jobs ARKHEN permanecem temporariamente contidos; o script de restauração preserva os sete estados ativos anteriores e as quatro pausas. A recuperação precisa ser confirmada por nova data de início do postmaster, saúde dos serviços e readback dos jobs; HTTP 403 e uma captura de gráfico não são provas de reinício.

## Aviso no login às 22h51 local

A captura do usuário mostra `CLOUD_REQUEST_FAILED`, estágio `arkhen_identity_lookup`, HTTP504 e duração5557ms. `web/cloud-library.js` apenas publica o diagnóstico sanitizado recebido do backend; não é a origem da chamada. Em `lib/supabase-cloud.mjs`, o bootstrap consulta a identidade antes de gerar a sessão Auth e executar `arkhen_identity_bind`. A otimização posterior do bind, documentada em [recuperação da Home](home-movie-recovery-20261017.md), não alcança uma falha anterior no lookup.

O lookup definido no schema é um SELECT por chave primária de `provider_identities`, sem ranking, catálogo ou gravação. O HTTP504 recebido difere do aborto local `CLOUD_TIMEOUT`; a captura não determina qual componente remoto esgotou o prazo. O código do gateway preserva o status HTTP do upstream. O login do provedor pode permitir montar a interface enquanto a conexão da biblioteca na nuvem falha. Recuperação mantém isolamento da conta, dados locais e espera progressiva; ocultar o aviso não recuperaria a sincronização.

Às **01h53m49s UTC de17/10 (22h53m49s local de16/10)**, a leitura administrativa mínima confirmou zero jobs ARKHEN ativos e o mesmo início do postmaster, `2026-10-16T22:36:16.562819Z`. A consulta de saúde na mesma rodada retornou DB `ACTIVE_HEALTHY`, Auth e REST `UNHEALTHY`. Portanto o reinício autorizado ainda não está comprovado e a indisponibilidade do serviço permanece. Não foi feita nova alteração SQL, chamada de login, leitura de biblioteca privada, teste ou uso do navegador. Aguardando a ação do usuário no painel para verificar recuperação e restaurar os sete jobs anteriormente ativos.

## Reinício confirmado e retomada gradual

Após o usuário informar o reinício pelo painel, a leitura das **01h57m57s UTC** confirmou novo início do postmaster em **2026-10-17T01:57:24.061264Z (22h57m24s local)**, com zero jobs ARKHEN ativos. Banco, Auth e REST retornaram saudáveis na primeira checagem. Não houve segundo reinício desta equipe nem alteração de capacidade/configuração.

A restauração foi dividida: primeiro IDs1/2/3/8/10; depois o despachante de catálogo5; por último o de marcadores4. As operações guardam inventário, nomes, cadências e hashes dos comandos. Os IDs6/7/9/11 permanecem na pausa previamente capturada. Arquivos: `restore-application-crons-stage-one-20261017.sql`, `restore-application-crons-stage-two-20261017.sql` e restauração final `restore-application-crons-20261017.sql`.

Houve oscilação inicial: depois do primeiro grupo, REST voltou a `UNHEALTHY`, enquanto banco/Auth permaneceram saudáveis. Os ciclos naturais das01h59 concluíram em21ms (enqueue) e9ms (navegação), sem falha. A amostra de atividade das01h59m46s mostrou sessões internas de PostgREST/Realtime/exporter, sem bloqueadores, e não identificou uma RPC ARKHEN pesada. Não se atribuiu a indisponibilidade aos dois jobs por coincidência temporal.

As capturas do usuário às22h59 mostram503 nas revisões live/movies e Home. O gráfico anexado seleciona22h55, anterior ao reinício, portanto não mede o resultado dele. A mensagem de acesso do Safari refere-se a um `/api/details` relativo à mesma origem; a hidratação possui abort de6s e cancelamento na troca de geração. A captura não prova CORS nem confirma o cancelamento como causa; não foram alteradas permissões de origem. O503 é um retorno explícito quando as leituras de nuvem não podem produzir resultado válido.

REST voltou a saudável em duas leituras separadas antes do segundo grupo. Às **02h02m25s UTC**, a leitura confirmou seis jobs ativos e nove execuções naturais bem-sucedidas desde o reinício: enqueue/navegação nos minutos01h59,02h00,02h01 e02h02, além do despachante de catálogo em34ms às02h02. A saúde de banco/Auth/REST continuou positiva. A restauração final dos sete jobs respondeu com sucesso; o readback e ciclo seguinte devem fechar a evidência. Duração do despachante não certifica conclusão do trabalho na Edge; saúde não certifica CPU ou I/O normalizados. Nenhum teste, chamada funcional privada, navegador ou mídia foi executado.

**Estado final conferido às02h04m33s UTC (23h04m33s local):** sete jobs ativos, IDs1/2/3/4/5/8/10, e quatro pausados, IDs6/7/9/11, com as cadências anteriores. Foram17 execuções naturais concluídas sem falha desde a retomada, entre8ms e233ms. O primeiro disparo de marcadores pós-retomada concluiu em83ms às02h04; catálogo em31ms e privacidade em233ms às02h03. Os dois jobs diários foram reativados, mas seu horário ainda não ocorreu nesta janela. A checagem final retornou DB/Auth/REST `ACTIVE_HEALTHY`.

A contenção total terminou e as rotinas originalmente ativas foram restauradas. Persistem as quatro pausas anteriores documentadas, não uma pausa completa da aplicação. A recuperação observada cobre serviços e execuções do agendador; resultado final dos workers, funcionamento privado do login/Home e queda sustentada de CPU/IOwait não foram certificados por essas leituras. O último gráfico fornecido ainda era anterior ao reinício. A operação `inspect-recovery-after-restart.sql` limita o histórico aos35 últimos runids e filtra o início do postmaster, retornando apenas metadados/classificação de falha.

## Captura posterior às23h05 e limite da causa identificada

O usuário informou que a CPU normalizou e enviou captura das23h05m42s, agora cobrindo22h55–23h05, portanto incluindo período posterior ao reinício. O painel exibe36,27% e a linha de IOWait deixou o patamar continuamente alto, com intervalos baixos, tempo ocioso maior e picos ainda presentes. Isso comprova melhora na janela exibida, sem assegurar estabilidade futura ou ausência de pressão de I/O.

O gargalo diretamente observado foi espera por I/O, acompanhada de degradação de Auth/REST, timeouts e falhas de inicialização de jobs. Trabalho periódico desnecessário em TV/limpeza/métricas era um amplificador identificado e recebeu correções/contenção. Entretanto, a pausa integral não recuperou os serviços de forma sustentada mesmo com pouco volume PostgreSQL medido; o reinício foi seguido da recuperação e a retomada parcial das rotinas manteve execuções rápidas. Não foi isolado o gatilho do estado persistente nem medido I/O completo do host: swap, memória, latência de volume, orçamento de I/O e comportamento dos serviços permanecem hipóteses, não causas raiz demonstradas. Os quatro jobs ainda pausados também limitam atribuir o resultado somente ao reinício ou somente às otimizações.
