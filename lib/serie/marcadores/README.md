# Tempos e marcações de Séries no backend

Separação local em 16/10/2026. Atualização de 17/10: o player usa `rota.mjs` e `sob-demanda.mjs` para consultar somente o episódio em reprodução. O agendamento global da Edge `series-markers-sync` foi desativado; a ferramenta de coleta histórica permanece para execução administrativa explícita. Ver [contrato e evidências](../../../docs/series-markers-on-demand-20261017.md).

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.mjs` | Sync manual: carregar snapshot, normalizar, exportar derivado aberto antes de publicar. |
| `skipdb.mjs` | Conector do dump público SkipDB, redirects permitidos, limite de bytes, prazo, cancelamento e cache de 24 horas. |
| `normalizacao.mjs` | Validação, identidade IMDb/episódio/edição e conflitos entre referências. |
| `supabase.mjs` | Publicação pelo adaptador servidor existente; inserções imutáveis e ativação somente da própria fonte não verificada. |
| `arquivos.mjs` | Escrita atômica de snapshots derivados. |
| `contrato.mjs` | Licença, limites e códigos de falha. |
| `revisao.mjs` | Revisão assistida de identidade por título, ano e IMDb; usada pela ferramenta manual. |

As ferramentas `tools/sync-series-markers.mjs` e `tools/review-series-markers.mjs` consomem estes módulos. O antigo `SeriesMarkerScheduler` não tinha consumidor de produção e foi removido, preservando a coleta central com lease na Edge. As ferramentas não foram executadas contra fontes ou banco nesta reorganização.

A Edge mantém `pipeline.mjs` para orquestração, `store.mjs` para Supabase, `incremental.mjs` para páginas/checkpoints e `retention.mjs` para retenção. Seus conectores vivem em `supabase/functions/series-markers-sync/conectores/`: `orquestrador`, `http`, `skipdb`, `introdb` e `dump`. Rate limit, cooldown por fonte, autenticação em header, inventário e timestamps sem ajuste permanecem preservados. A continuação em 11 segundos permanece desativada por padrão, exigindo a flag existente e resultado `ready`.

SkipDB/IntroDB fornecem referências de abertura/créditos, não a duração real de um episódio. Coincidência de duração e concordância entre APIs não verificam a edição WPLAY. No pedido posterior de 17/10, o usuário definiu contagem cancelável de 5 segundos com salto automático como padrão também para essas referências. A origem comunitária permanece identificada e o final de `outro` preserva cenas posteriores. Diferenças entre fontes até 5s inclusive são toleradas.

A duração total real é observada pelo vídeo ativo; `web/serie/duracao.js` apenas interpreta duração explícita do episódio e apresenta o tempo. O parser `lib/media-duration.mjs` e a sonda limitada `lib/mp4-duration.mjs` continuam compartilhados com Filmes/provedores. Nenhuma sonda do primeiro episódio passou a definir duração de uma série.

Validação local: testes sintéticos de identidade, fonte, bytes, publicação, cooldown, cancelamento, reprodução controlada e progresso. Sem navegador, mídia real, execução remota, migration ou deploy.
