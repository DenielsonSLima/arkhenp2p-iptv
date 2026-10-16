# Backend modular de Filmes

Data: 16/10/2026. Escopo: catálogo, detalhes, arte, política de duração e recomendações de Filmes. Implementação local e integração central revisadas estaticamente; sem testes, navegador, mídia, login, escrita remota, instalação ou reinício.

## Responsabilidades extraídas

| Módulo canônico | Responsabilidade real |
| --- | --- |
| `lib/filmes/orquestrador.mjs` | Seleciona exclusivamente as rotas/fatias de Filmes, valida método/entrada e controla resposta, abort, geração de conta, PIN e encerramento. |
| `lib/filmes/servicos.mjs` | Compõe os casos de uso e controla recomendações exclusivamente pela RPC privada; falha retorna indisponibilidade explícita. |
| `lib/filmes/catalogo.mjs` | Carrega snapshot/página/modelo de Filmes, preserva revisões e paginação, aplica classificação atual e registra somente dados compatíveis no repositório de busca da sessão. Reutiliza o mecanismo compartilhado de transporte/fallback. |
| `lib/filmes/metadados.mjs` | Consulta o filme selecionado, separa arte de detalhes/duração, conserva classificação nativa e autoriza a resposta. A opção de duração é encaminhada à implementação limitada já existente do provider. |
| `lib/filmes/conector-supabase.mjs` | Contém a implementação da RPC `arkhen_movie_recommendations`, usando chave pública/JWT do espectador, prazo de 3s e validação do DTO. Adapta os leitores compartilhados de catálogo para o tipo fixo `movies`. |
| `lib/filmes/recomendacoes-request.mjs` | Validação canônica `{id,limit,hidden,hiddenItems}`, com limite de 1–10 resultados e padrão 10. |
| `lib/filmes/recomendacoes-sessao.mjs` | Implementação legada movida do modelo local, conservada como compatibilidade; deixou de participar do endpoint após o pedido de ranking integral no banco. |
| `lib/vod/catalogo-nativo.mjs` | Núcleo WPLAY de catálogo/metadados compartilhado por Filmes e Séries; mesma classe `WplayVODCatalog`, com mapas, páginas e gerações independentes. Não contém o transporte HTTP da mídia nem cria uma sessão. |

`lib/wplay-vod.mjs`, `lib/session-movie-recommendations.mjs` e `lib/movie-recommendations-request.mjs` são fachadas documentadas. As implementações foram movidas, não copiadas; não há dois modelos de recomendações ou dois catálogos nativos em execução.

O núcleo VOD foi colocado em `lib/vod/` para não atribuir catálogo de Séries ao domínio de Filmes. Os métodos e algoritmos desse núcleo foram preservados; só os imports relativos e a documentação de responsabilidade mudaram. `nativeEpisodeID` mantém sua função e namespace anteriores. O provider composto continua importando a fachada compatível, validada pelo bundle.

## API e integração central

```js
import {OrquestradorFilmes} from './filmes/orquestrador.mjs';

const movieRoutes = new OrquestradorFilmes({
  cloudRuntime,
  catalogSearch: localSearch,
  respond: json,
  readInput: input,
  isClosed: () => shuttingDown
});

// Depois da guarda compartilhada de conta/provedor e antes dos handlers
// genéricos. handle() retorna false para qualquer outro domínio.
if (await movieRoutes.handle(req, res, url, {state, client})) return;
```

| Requisição atendida | Contrato conservado |
| --- | --- |
| `POST /api/recommendations/movie` | Body máximo de 65.536 bytes; DTO de recomendações existente; resposta indisponível continua 503 com `MOVIE_RECOMMENDATIONS_UNAVAILABLE`, sem inventar zero autoritativo. |
| `GET/HEAD /api/details?type=movie&id=...` | ID nativo numérico, detalhes do provider e autorização atual. `artwork=1` conserva a lista pública restrita de campos; `duration=1` solicita somente a sonda opcional já existente. Ausência continua 404. |
| `GET/HEAD /api/catalog?type=movies` | Mesmos parâmetros `category/page/paged/cursor/snapshot/refresh/cache`, snapshots completos, páginas/previews parciais e classificação parental. |
| `GET /api/catalog/read-model?type=movies` | Modelo de navegação da geração atual; preparação/indisponibilidade continua 503 `CATALOG_MODEL_PREPARING`. |

A integração foi aplicada pelo agente principal em `lib/app-server.mjs`: import e instância novos; dispatch depois da guarda e de TV; parser/instância antigos de recomendações removidos; bloco compartilhado de busca/Home deixou de conter o caso de filme. O marcador `movieRequest` permanece apenas para aceitar POST na guarda de método, e a allowlist de validação do provedor foi conservada. O body de recomendações é lido uma única vez pelo orquestrador.

O equivalente mínimo do patch de composição é:

```diff
-import {SessionMovieRecommendations} from './session-movie-recommendations.mjs';
-import {movieRecommendationsRequest} from './movie-recommendations-request.mjs';
+import {OrquestradorFilmes} from './filmes/orquestrador.mjs';
-const localMovieRecommendations = new SessionMovieRecommendations({catalogSearch:localSearch});
+const movieRoutes = new OrquestradorFilmes({cloudRuntime,catalogSearch:localSearch,respond:json,readInput:input,isClosed:()=>shuttingDown});
 if (await tvRoutes.handle(req,res,url,{state,client})) return;
+if (await movieRoutes.handle(req,res,url,{state,client})) return;
-if (searchRequest || homeRequest || movieRequest) {
+if (searchRequest || homeRequest) {
```

Além desses hunks, a composição removeu o bloco de parsing de `movieRequest` e as branches de ranking/fallback/erro de Filmes do bloco de busca/Home. Não há um segundo parser nem despacho antes da validação do provedor.

`CloudRuntime` foi alterado somente no import/constructor do conector de Filmes, delegação de `movieRecommendations(state,request,options)` e limpeza correspondente em `close()`. A RPC real mora no módulo de Filmes; o método público anterior continua compatível. A instância do orquestrador não cria timers, streams ou outra sessão e não requer teardown separado.

## Catálogo, identidade e metadados

O núcleo nativo conserva as categorias entregues pelo provedor e usa suas URLs autorizadas para paginação; não monta um endpoint de catálogo a partir do nome do filme. Cada tipo mantém seu próprio contador de geração. Invalidar Filmes não descarta páginas de Séries, e retornos da geração anterior não repovoam o cache corrente.

O detalhe nativo conserva `vod_search_url + /@id`, seguido do token pelo helper já existente. `{}` representa título ausente e continua 404; uma resposta de outro ID é recusada. O cache conserva a lista completa de fontes de detalhe mesmo quando uma página posterior traz apenas uma lista reduzida. IDs públicos e propriedade de favoritos/histórico não foram recalculados.

Metadados e imagem de filme continuam sendo responsabilidade do provider da conta. O módulo de Filmes não abre o catálogo de Séries, não usa o primeiro episódio como duração de filme e não inicializa EPG ou TV. As recomendações do endpoint usam somente o JWT da conta e ranking da RPC; o helper legado de metadados carregados não é acionado em falha. O [contrato de ranking versão 2](movies-recommendations-ranking-20261016.md) registra a alteração e a migration preparada, ainda sem aplicação remota por esta frente.

## Duração e resolução

O parser compartilhado `lib/media-duration.mjs` reconhece unidades explícitas ou timecodes. Um número genérico chamado `duration`/`runtime` não ganha unidade presumida. A modularização conserva esse comportamento.

Quando solicitada para o filme selecionado e ausente nos metadados, a duração reutiliza `lib/mp4-duration.mjs`: até oito requests, orçamento total de 1MiB e deadline de 6s, lendo cabeçalhos de caixas MP4 e `mvhd`. Exige 206 e `Content-Range` coerente, limita redirects e remove credenciais de headers ao mudar de origem. Uma resposta que ignora Range não é aceita como convite para baixar o arquivo completo. Abort e início da reprodução continuam cancelando a sonda no provider existente. Falha retorna duração desconhecida; não foi criado outro prober ou retry de mídia.

Não foi criado um resolvedor de qualidade por nomes SD/HD/FHD/4K. Os campos `source.width/height` já fornecidos pelo provider, quando existentes, continuam sendo metadados declarados; não são resolução audiovisual medida nesta etapa. Os campos de fontes nativas e o rótulo do título não demonstram dimensões, ABR ou estabilidade. Nenhuma fonte foi reproduzida ou sondada nesta revisão.

## Transporte preservado

`/api/play`, `/api/stop`, `/api/playback/status`, `/api/asset` e o proxy continuam compartilhados. Não foram movidos para Filmes nem duplicados. O leitor `lib/vod-upstream.mjs` conserva um retry de GET/HEAD apenas para falhas transitórias antes de entregar a resposta, usando a mesma origem/faixa; não repete um corpo parcialmente enviado.

O proxy central conserva `Range`, 200/206 e `Content-Range/Content-Length/Accept-Ranges`; devolve 416 com o total válido quando informado. 429/`Retry-After`, o cooldown por cliente/origem e o erro `PLAYBACK_RATE_LIMITED` continuam no mecanismo compartilhado, sem tentativa automática de outra fonte. A sonda opcional de duração continua podendo retornar desconhecido diante de uma resposta sem 206; isso não foi apresentado como confirmação ou substituição do cooldown do player.

Tentativa de abertura, geração, `sid` quando aplicável, propriedade dos assets e abort da transferência conservam seus donos anteriores. O orquestrador de Filmes não chama `beginPlayback`, `stopPlayback`, engine ou transporte OTT. Uma consulta tardia de catálogo/detalhes/recomendações é rejeitada após mudança de cliente, geração Auth, PIN ou encerramento; só então ocorre registro/classificação da resposta atual.

## Evidência e verificação

A fonte principal desta extração é o código atual e seus chamadores. O [contrato APK existente](../analysis/WPLAYP2P-11.9.0d-auth-contract.md) é histórico e registra limites de cobertura VOD; não foi usado para inventar endpoints, dimensões ou comportamento não recuperado. A [inspeção atual do APK](tv-backend-modules-20261016.md) diferencia inventário de campos e métodos nativos sem corpo Java. Não foi necessária nova execução de REA para mover código-fonte disponível.

Foram feitas leitura dos contratos, revisão do diff, `node --check` nos módulos novos/movidos e no runtime, bundles esbuild não executados do orquestrador, provider e runtime para diretório temporário, e `git diff --check`. A integração central aplicada pelo agente principal também foi lida contra a API acima. Não foram executados testes automáticos, navegador, requisições de catálogo/mídia, login, escrita SQL, deploy ou restart. Essas checagens não certificam seek, reprodução, duração real de um arquivo ou disponibilidade atual da RPC; a validação funcional continua reservada ao usuário.
