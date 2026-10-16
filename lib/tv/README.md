# Backend de TV ao vivo

Implementações próprias de TV, compostas pelo servidor e pelo runtime existentes. Os módulos não criam outra conta WPLAY, conexão Supabase ou sessão de mídia para enumerar metadados.

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.mjs` | Rotas autenticadas GET `/api/live/sources`, `/api/tv/guide`, `/api/epg` e `/api/games`, com validação de entrada, conta, geração, PIN e cancelamento do leitor. |
| `conector-supabase.mjs` | Fachada de leitura do guia/EPG da TV; recebe o transporte Supabase já configurado e possui seus caches/limites. |
| `grade-runtime.mjs` | Reuso da projeção do guia por partição, proteção e fuso; filtragem dos canais solicitados e preservação de snapshot anterior em falha. |
| `grade-compartilhada.mjs` | Deduplicação e leitura em lote do cache EPG, preservando somente informação ainda pertinente. |
| `grade-legada.mjs` | Compatibilidade transitória com metadados já publicados. Calcula janelas no backend e identifica explicitamente a resposta legada/parcial/desatualizada. Não baixa EPG WPLAY para cada espectador. |
| `inventario-fontes-wplay.mjs` | Inventário das fontes fornecidas para o canal autenticado, sem iniciar ou parar a engine. |
| `fontes.mjs` | Entradas privadas de origem, DTO público sem endereços, IDs de fonte, classificação anunciada e seleção validada. |
| `resolver-web.mjs` | Associação conservadora entre canal nativo e OTT, com identidade explícita ou nome completo inequívoco. |
| `transporte-web.mjs` | Sessão OTT de reprodução, fila, cancelamento, `sid/gen`, parada e propriedade de manifesto/segmentos. |

O serviço HTTP central permanece em `lib/app-server.mjs`; ele despacha metadados TV ao orquestrador. Play, stop, status e proxy atendem também Filmes/Séries e continuam compartilhados. `lib/live-playback-session.mjs` conserva a intenção de abertura; `lib/media-request-backoff.mjs` conserva os prazos de recuperação. Uma extração futura desses módulos exige preservar os chamadores VOD.

`CloudRuntime` delega `epg()` e `tvGuide()` ao conector de TV. Auth, bootstrap da biblioteca e catálogo dos outros domínios permanecem nos módulos anteriores. O conector não agenda a coleta, renova credenciais ou inicializa engine durante uma leitura. Realtime é recebido pela biblioteca autenticada no navegador; TanStack Query pertence à camada cliente, sem duplicação de SDKs no backend.

## Contratos de reprodução

- O ID de canal nativo permanece a identidade usada em favoritos, histórico e seleção. O ID OTT não o substitui.
- Endereços de mídia e credenciais permanecem no backend da sessão. A resposta de fontes contém somente descritores públicos e IDs opacos.
- HTTP, TVBus e TVCarS são contratos distintos. Não fabricar HTTP a partir de URI P2P; o bridge TVCore só recebe uma fonte TVBus selecionada em modo nativo explícito.
- Região, afiliada, número de canal e identidade ambígua são preservados pelo resolvedor.
- Guia e catálogo não reiniciam reprodução. Stop, conta, geração e cancelamento impedem leitores atrasados de reviver uma fonte.
- 401/403, 429, falha de parada e falha estrutural de engine não representam uma simples necessidade de diminuir resolução.

## Diagnóstico por fase

| Sintoma | Primeiro caminho a conferir |
| --- | --- |
| Fontes/qualidades ausentes | Orquestrador → inventário → `fontes.mjs` → provider autorizado. |
| Canal nativo sem associação OTT | `resolver-web.mjs`; não substituir por afiliada ou nome aproximado. |
| Guia sem dados ou lento | Conector → RPC/projeção → snapshot publicado; depois distinguir publicação, consulta e renderização. |
| 502/429 ou trocas repetidas | Proxy/status/backoff compartilhados → `transporte-web.mjs` → intenção de reprodução. Conservar o status de origem no diagnóstico sanitizado. |
| Favoritos de outro dispositivo ausentes | Adaptador privado no navegador e `CloudLibrary`/Auth/RLS; não procurar favoritos nas tabelas globais de TV. |

Relatório detalhado da inspeção estática do APK e dos limites: [backend e APK](../../docs/tv-backend-modules-20261016.md). Integração geral: [modularização](../../docs/tv-modularization-20261016.md).
