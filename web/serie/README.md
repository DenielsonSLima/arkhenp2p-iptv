# Séries

Implementação canônica do domínio, composta pelo aplicativo em `web/app.js`. O identificador externo continua `series`; IDs de série e de episódio conservam sua função original. Catálogo, biblioteca, SDK, reprodução e áudio reutilizam os proprietários compartilhados, sem outro login ou player.

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.js` | Estado da aba e composição de serviços, detalhes, busca, Realtime e apresentação. |
| `services.js` | Carrega somente o catálogo Séries pelo repositório existente; lê detalhes selecionados pela API autenticada, valida resposta e mantém até64 detalhes; monta URL somente para episódio válido. |
| `scope.js` | Isola conta/geração/PIN/ocultações de Séries. Metadados da mesma conta sobrevivem à conclusão tardia do bootstrap cloud. |
| `hooks.js` | Coalescência dos leitores e cancelamento independente; último leitor encerra o transporte, troca de conta invalida respostas anteriores. |
| `busca.js` | Destino `type=series` da única `RemoteSearch`. Preserva ordem, contagens e paginação da RPC; não classifica candidatos no navegador. |
| `tanstack-query.js` | Usa o QueryClient injetado pela aplicação e limita o namespace Séries a64 detalhes; funciona pelo serviço enquanto o cliente ainda não foi carregado. Não instancia SDK/client novo. |
| `realtime.js` | Consome eventos já validados da conexão existente, rejeita outra partição/revisão antiga e invalida somente Séries. Progresso não recarrega catálogo nem reinicia vídeo. |
| `supabase.js` | Projeção de leitura da única CloudLibrary: confere conta/biblioteca/usuário/provedor/partição e filtra favoritos/histórico/episódios de Séries. Não possui socket, fila ou armazenamento próprios. |
| `previa.js`, `titulo.js` | Apresentação e fatos da série selecionada, sem tratar duração de episódio como duração da série. |
| `temporadas.js`, `episodios.js` | Temporadas fornecidas, identidade/sequência dos episódios e painel de seleção. |
| `capa.js` | Fontes e miniaturas dos episódios com a política de arte existente. |
| `progresso.js` | Store único de progresso por episódio, apresentação e contrato `seriesProgressEntry`, preservando conta e privacidade adulta. |
| `duracao.js` | Interpretação de duração explícita do episódio e apresentação do tempo, sem atribuí-la à série inteira. |
| `marcadores/` | Leitor/orquestrador e adaptador da biblioteca cloud para abertura/créditos, com identidade, edição e cancelamento próprios. |
| `sequencia.js` | Detalhes necessários para próximo episódio, respeitando cancelamento, ID nativo e seleção atual. |
| `audio.js` | Faixas de áudio e sessão Séries sobre o único grafo de áudio. |
| `legenda.js` | Trilhas HLS/nativas e arquivo de até2MB, com cancelamento por episódio. |
| `resolucao.js` | Níveis realmente expostos/medidos daquele episódio e escolha manual. |
| `buffer.js` | Perfis VOD equilibrado/estável, sem relógio ou sincronização de TV ao vivo. |
| `reproducao.js` | Retomada, metadados, guardas de seleção e recuperação limitada, conservando pausa429 e encerramento anterior. |

`SeriesFeature.configure` recebe `request`, `getScope`, `getQueryClient`, `search`, `cloudLibrary`, `getSession`, `isVisible` e `canRemember`. O aplicativo usa `details(item,options)`, `peekDetails(item)`, `invalidateDetails()`, `search(text,options)`, `renderPreview(...)`, `onSharedUpdate(...)` e `onLibraryChange(...)`. Atualizar o catálogo invalida os detalhes sem interromper a seleção autorizada em andamento. `services.playbackURL(item,{episode,attempt})` exige um episódio nativo e formato válidos. Escritas pessoais continuam pelo bridge existente; `EpisodeProgressStore` continua sendo uma única instância por conta.

A busca compartilhada cancela/remove/limpa somente seu namespace `arkhen-global-search`, preservando os detalhes de Séries que usam o mesmo QueryClient. No aplicativo, o fallback de snapshot local fica desativado para a busca específica `series`; falha da RPC mantém o estado de erro, sem criar ordenação alternativa. A busca global legada tem contrato separado.

O [backend de Séries](../../lib/serie/README.md) possui catálogo/metadados/orquestração específicos sobre o núcleo VOD, sem inicializar EPG/OTT de TV. Preferências e marcações da edição mantêm seus controles existentes; referências comunitárias não viram marcações audiovisuais verificadas por esta extração.

Verificação desta frente: 23 testes sintéticos de catálogo/escopo/busca/cancelamento/Realtime/biblioteca e isolamento do QueryClient aprovados. Apresentação, player e rotas possuem verificações próprias; isso não comprova reprodução, saúde do banco ou resultado visual. Sem navegador ou mídia nesta reorganização. Veja a [integração e seus limites](../../docs/series-modularization-20261016.md).

Veja o [mapa do sistema](../../docs/system-modularization-20261016.md).
