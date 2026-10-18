# TV ao vivo no navegador

Implementação canônica de TV. A página principal compõe este domínio por `TVOrchestrator`; os consumidores importam os módulos desta pasta. As fachadas antigas de guia e fontes foram removidas após a migração dos imports.

## Mapa de manutenção

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.js` | Compõe serviços, guia, catálogo, favoritos, áudio e agenda. Prepara descritores de fontes e a URL autenticada de TV; coordena reset/dispose. |
| `services.js` | Chamadas de catálogo live, programação, fontes e jogos pelas rotas locais, deduplicação de leitores, cancelamento por escopo e cache limitado de descritores públicos. |
| `scope.js` | Chave de conta, biblioteca, partição e proteção parental usada pelo domínio. |
| `supabase.js` | Adaptador da `CloudLibrary` existente para favoritos de TV; reutiliza Auth, RLS, fila de gravação e conexão já estabelecidos. |
| `realtime.js` | Consome eventos já autenticados. Revisão EPG invalida somente o guia; revisão de catálogo live invalida somente canais; alteração de favoritos live reconcilia somente TV. |
| `tanstack-query.js` | Query compartilhada do guia e chaves de cache de TV. Cards e vizinhos consomem o mesmo mapa; um card não abre uma consulta EPG própria. |
| `buffer.js` | Perfis e políticas HLS exclusivos de TV, com configuração de abertura e sincronização ao vivo. |
| `canais/lista.js` | Lista, categorias, favoritos e numeração sobre o repositório de catálogo da conta, sem baixar Filmes/Séries. |
| `canais/favoritos.js` | Projeção privada `live:<id>`, alteração otimista, reconciliação remota e indicação de gravação/pendência. |
| `canais/programacao.js` | Valida o DTO do servidor e suas janelas anterior/atual/próxima, horários e progresso. Não escolhe programa pelo relógio do navegador. |
| `canais/guia-cards.js` | Montagem e atualização da programação nos cards. |
| `canais/feed.js` | Programação do canal em reprodução. |
| `canais/guia-vizinhos.js` | Programação dos canais anterior e próximo sobre o mesmo guia compartilhado. |
| `canais/visualizacao.js` | Construção dos cards de TV com dependências visuais injetadas. |
| `canais/resolucoes.js` | Fontes oferecidas, capacidades do navegador, escolha inicial HLS e redução limitada de qualidade. Mantém qualidade declarada separada de resolução medida. |
| `canais/audio.js` | Faixas de áudio e transição de volume do canal usando o player ativo. |
| `canais/legendas.js` | Faixas de legendas disponíveis na fonte e sua seleção. |
| `canais/faixas.js` | Identificação e enumeração de faixas expostas por HLS ou pelo navegador. |
| `jogos/agenda.js` | Agenda e associação de partidas aos canais elegíveis. |
| `logos/resolver.js` | Índice local de logos por ID e nome exato, manifesto e geometria de apresentação. |
| `logos/manifest.json` | Arquivos canônicos, hashes, associações e proveniência. Veja [limites de categorias](logos/README.md). |

`web/app.js` continua responsável pela sessão geral, navegação e pelo elemento de vídeo compartilhado. `web/player-tools.js` chama os módulos de TV somente no ramo `kind === 'live'`. Áudio e legendas reutilizam infraestrutura comum de apresentação/processamento; não criam uma transmissão paralela.

## Ciclo de vida e dados

Configure o orquestrador uma vez por instância da aplicação. Use `reset()` ao trocar conta, geração de conexão ou proteção; use `dispose()` ao encerrar o domínio. As respostas assíncronas validam escopo e geração antes de publicar dados.

A coleta global da programação e a projeção atual do guia são fases distintas. O temporizador da query pede uma nova projeção no prazo informado pelo servidor; não agenda uma coleta WPLAY. O cliente consome `epg_cache_versions` pelo socket compartilhado e não abre outro cliente Supabase por card, tela ou canal.

Cards, favoritos, player e vizinhos registram IDs em `TVGuideClient.subscribe(...,{ids})`; seleções mutáveis notificam por `unsubscribe.updateIds()`. A união usa uma consulta compartilhada e a RPC filtra antes de calcular. Assinaturas antigas e conjuntos extremos conservam o mapa completo. Regras e progresso continuam no servidor. [Decisão e limites](../../docs/tv-epg-on-demand-20261017.md).

Favoritar um canal não altera seu ID nem os favoritos de Filmes/Séries. Estado otimista ou uma gravação na fila local não comprova persistência remota. Para um problema entre dispositivos, comece em `supabase.js`/`canais/favoritos.js`, depois siga para `web/cloud-library.js`, sua fila e a política remota da conta.

## Onde investigar

- Guia lento ou vazio: `services.js` → `tanstack-query.js` → `canais/programacao.js` → [backend TV](../../lib/tv/README.md).
- Repetição de abertura ou falha HTTP: integração do player em `web/app.js`, `canais/resolucoes.js` e transporte em `lib/wplay/ao-vivo/transporte-web.mjs`; os códigos e prazos continuam na infraestrutura compartilhada.
- Qualidade ausente: inventário público de `services.js` e `canais/resolucoes.js`; compare as variantes reais da fonte antes de interpretar um rótulo “4K”.
- Volume ou faixa incorreta: `canais/audio.js`; legendas: `canais/legendas.js` e `web/subtitle-layout.js`.
- Logo ausente: `logos/resolver.js`, manifesto e `web/artwork-url.js`; preserve os endereços antigos durante a migração de favoritos/cache.

Mapa da etapa e limites de verificação: [modularização de 16/10/2026](../../docs/tv-modularization-20261016.md).
