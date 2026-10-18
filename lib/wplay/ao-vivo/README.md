# WPLAY ao vivo

Esta pasta adapta os serviços do provedor à conexão existente. Não abre outro
cliente para metadados, não reclassifica um ID OTT como ID nativo e não usa VOD
para obter a grade.

| Arquivo | Responsabilidade |
| --- | --- |
| `servicos.mjs` | Catálogo de canais, EPG, jogos e descritores de fontes do cliente injetado. |
| `catalogo-autorizado.mjs` | Releitura de canais com sessão/token já autorizados, sem login por polling. |
| `grade.mjs` | Leitura integral limitada, interpretação de horários, cache e retenção da programação válida. |
| `jogos.mjs` | Contrato de data/fuso/idioma e normalização da agenda recebida. |
| `inventario-fontes.mjs` | Fontes reais do mesmo canal, sem iniciar mídia durante a listagem. |
| `fontes.mjs` | Validação/seleção e DTO público das fontes, preservando endereços privados no backend. |
| `resolver-web.mjs` | Associação conservadora do canal nativo com o player OTT. |
| `transporte-web.mjs` | Uma sessão privada de mídia OTT, com fila, cancelamento, STOP e propriedade das URLs. |

A projeção de produto, RPC Supabase, favoritos e Home continuam em `lib/tv/`.
O transporte recebe fontes autorizadas; não traduz TVBus/TVCarS em HTTP.
