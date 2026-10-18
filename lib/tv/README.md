# Backend de TV ao vivo

Implementações próprias de TV, compostas pelo servidor e pelo runtime existentes. Os módulos não criam outra conta WPLAY, conexão Supabase ou sessão de mídia para enumerar metadados.

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.mjs` | Rotas autenticadas GET `/api/live/sources`, `/api/tv/guide`, `/api/epg` e `/api/games`, com validação de entrada, conta, geração, PIN e cancelamento do leitor. |
| `conector-supabase.mjs` | Fachada de leitura do guia/EPG da TV; recebe o transporte Supabase já configurado e possui seus caches/limites. |
| `grade-runtime.mjs` | Cache/deduplicação por partição, proteção, fuso e conjunto de canais; reuso de mapa completo existente e preservação de snapshot anterior em falha. |
| `grade-compartilhada.mjs` | Deduplicação e leitura em lote do cache EPG, preservando somente informação ainda pertinente. |
| `grade-legada.mjs` | Compatibilidade transitória com metadados já publicados. Calcula janelas no backend e identifica explicitamente a resposta legada/parcial/desatualizada. Não baixa EPG WPLAY para cada espectador. |
| `../wplay/ao-vivo/fontes.mjs` | Contrato consumido do adaptador: entradas privadas de origem, DTO público sem endereços, IDs de fonte, classificação anunciada e seleção validada. |

Os adaptadores próprios do provedor ficam em `../wplay/ao-vivo/`: catálogo,
grade recebida, jogos, inventário de fontes, associação nativo/OTT e transporte
web. O produto TV consome esses módulos pela conexão existente; não replica a
autenticação ou o cliente WPLAY. `grade-provedor.mjs` mantém a captura/projeção
TV por escopo e importa o leitor autorizado de catálogo e grade WPLAY.

O serviço HTTP central permanece em `lib/app-server.mjs`; ele despacha metadados TV ao orquestrador. Play, stop, status e proxy atendem também Filmes/Séries e continuam compartilhados. `lib/live-playback-session.mjs` conserva a intenção de abertura; `lib/media-request-backoff.mjs` conserva os prazos de recuperação. Uma extração futura desses módulos exige preservar os chamadores VOD.

`CloudRuntime` delega `epg()` e `tvGuide()` ao conector de TV. Auth, bootstrap da biblioteca e catálogo dos outros domínios permanecem nos módulos anteriores. O conector não agenda a coleta, renova credenciais ou inicializa engine durante uma leitura. Realtime é recebido pela biblioteca autenticada no navegador; TanStack Query pertence à camada cliente, sem duplicação de SDKs no backend.

Etapa posterior: [EPG sob demanda por canais necessários](../../docs/tv-epg-on-demand-20261017.md). RPC reutiliza janelas privadas por canal até revisão/fronteira, calcula progresso no servidor e não regrava uma revisão pública por minuto. Captura da origem continua independente.

## Contratos de reprodução

- O ID de canal nativo permanece a identidade usada em favoritos, histórico e seleção. O ID OTT não o substitui.
- Endereços de mídia e credenciais permanecem no backend da sessão. A resposta de fontes contém somente descritores públicos e IDs opacos.
- HTTP, TVBus e TVCarS são contratos distintos. Não fabricar HTTP a partir de URI P2P. A ponte Android experimental foi removida; a integração utiliza somente as fontes HTTP autorizadas e o transporte web oficial.
- Região, afiliada, número de canal e identidade ambígua são preservados pelo resolvedor.
- Guia e catálogo não reiniciam reprodução. Stop, conta, geração e cancelamento impedem leitores atrasados de reviver uma fonte.
- 401/403, 429, falha de parada e falha estrutural de engine não representam uma simples necessidade de diminuir resolução.

## Diagnóstico por fase

| Sintoma | Primeiro caminho a conferir |
| --- | --- |
| Fontes/qualidades ausentes | Orquestrador → inventário → `fontes.mjs` → provider autorizado. |
| Canal nativo sem associação OTT | `../wplay/ao-vivo/resolver-web.mjs`; não substituir por afiliada ou nome aproximado. |
| Guia sem dados ou lento | Conector → RPC/projeção → snapshot publicado; depois distinguir publicação, consulta e renderização. |
| 502/429 ou trocas repetidas | Proxy/status/backoff compartilhados → `../wplay/ao-vivo/transporte-web.mjs` → intenção de reprodução. Conservar o status de origem no diagnóstico sanitizado. |
| Favoritos de outro dispositivo ausentes | Adaptador privado no navegador e `CloudLibrary`/Auth/RLS; não procurar favoritos nas tabelas globais de TV. |

Relatório detalhado da inspeção estática do APK e dos limites: [backend e APK](../../docs/tv-backend-modules-20261016.md). Integração geral: [modularização](../../docs/tv-modularization-20261016.md).
