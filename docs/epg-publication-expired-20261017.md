# Captura EPG vencida com programação ainda disponível

Data: 17/10/2026. Escopo: diagnóstico administrativo somente de metadados de publicação e agendamento no projeto autorizado `wnicimkmzswksaqdtgdv`. Complementa o [isolamento de Home e recomendações](home-recommendations-isolation-20261017.md). Não houve coleta disparada, mudança de cron, jobs, cadência, funções ou dados de programação.

## Evidência remota

Uma leitura limitada às16:45:46UTC observou uma publicação não legada com760canais e41.830programas:

| Campo | Valor UTC |
| --- | --- |
| Captura da origem | 16/10/2026 03:59:09.673 |
| Expiração e próxima atualização da origem | 16/10/2026 09:59:09.673 |
| Horizonte conhecido | 19/10/2026 07:00:00 |
| Último enqueue EPG | 17/10/2026 12:15:00.245 |
| Próximo enqueue previsto pela cadência existente | 17/10/2026 18:15:00.245 |

A fonte estava habilitada, com intervalo21.600segundos. O último job terminou `failed` às14:16:45UTC de17/10, após8tentativas, código sanitizado `ECONNRESET`, sem candidato de snapshot selado ou publicado. Não havia EPG `queued` ou `leased` naquela leitura. O próximo horário previsto equivale a15:15 emMaceió; isso não garante que a futura coleta terá sucesso.

Uma segunda leitura às16:47:17UTC confirmou `arkhen-cache-enqueue` e `arkhen-cloud-catalog-sync` ativos, com agenda a cada minuto. Cada um tinha15execuções bem-sucedidas e nenhuma falha nos15minutos anteriores; o último sucesso foi às16:47:00UTC. Esses sucessos comprovam execução do agendamento, não captura bem-sucedida do fornecedor. `arkhen-tv-guide-clock` estava inativo conforme a arquitetura atual de cálculo sob demanda.

Nos metadados de jobs dos últimos14dias, o último sucesso EPG era16/10 às03:59:20UTC. Havia um candidato de snapshot publicado, capturado às03:59:09UTC e publicado às03:59:19UTC do mesmo dia. Não foi lido conteúdo de programas, payload de jobs, credenciais, perfis, biblioteca ou mensagens de execução. Nenhuma API de logs foi usada; de `cron.job_run_details` foram lidos exclusivamente contagens, status e timestamps agregados no intervalo explícito de15minutos.

## Interpretação e limite

`stale=true` está correto: o TTL da captura venceu. O horizonte ainda é futuro, portanto os mesmos dados podem continuar contendo programas atuais. As leituras HTTP normais do responsável principal retornaram programas atuais para os cinco canais pedidos, coerentemente com essa situação.

`nextRefreshAt` representa a próxima atualização da projeção de anterior/agora/próximo e progresso. Não é uma nova captura nem prova de frescor da origem; `snapshotFetchedAt`, `snapshotExpiresAt` e `sourceNextRefreshAt` têm essa função. O [contrato SQL vigente](../supabase/migrations/20261017011816_arkhen_tv_guide_on_demand_channels.sql) mantém essas informações distintas.

A publicação ficou antiga porque não houve nova coleta/publicação bem-sucedida. O código `ECONNRESET` identifica a falha registrada no último job, mas esses metadados não identificam o socket, componente ou servidor que encerrou a conexão. Não se atribui a causa ao fornecedor, banco, player ou a uma requisição específica sem evidência adicional. O indicador de captura antiga permanece verdadeiro; não foi mascarado como atualizado.

Consultas reproduzíveis, somente de leitura e com prazoSQL de5segundos:

- [Frescor e estado da publicação](../supabase/operations/inspect-epg-publication-freshness.sql): até6publicações, até10grupos de jobs recentes/ativos; sem conteúdo de programação ou identidades.
- [Cadência e último sucesso](../supabase/operations/inspect-epg-collector-cadence.sql): três agendas conhecidas,15minutos de status agregados de cron e14dias de metadados EPG; sem comandos ou mensagens.
