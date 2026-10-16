# Identidade e ranking das recomendações de Filmes

Data: 16/10/2026. Estado: proposta de contrato baseada na leitura local; não é migration aplicada nem certificação do catálogo remoto. Escopo desta frente: este documento. Nenhum código, SQL, mídia ou infraestrutura foi executado para validar o ranking.

O pedido atual exige até 10 filmes, em duas linhas de cinco quando a largura permitir, calculados e ordenados pela RPC. A prioridade é continuação/mesma franquia, depois universo comprovado e só depois semelhança por gênero. A grade é apresentação: a ordem recebida não deve ser recalculada no navegador.

## Causas observadas e metadados disponíveis

| Evidência no código local | Consequência |
| --- | --- |
| `supabase/migrations/20261015192346_arkhen_movie_recommendations.sql`, CTEs `groups`, `affinity`, `pool` e `final` | O ranking atual considera gênero, categoria, histórico e nota; não há coleção, franquia ou universo. Um título bem avaliado de ação pode preceder uma continuação. |
| Mesma RPC: `pool` limita 600 candidatos antes de carregar metadados | Acrescentar um peso de franquia somente depois desse limite deixa continuações fora do conjunto. Candidatos de vínculo forte precisam entrar antes do corte genérico. |
| `web/filmes/sugestoes/sessao.js`: `limit:3` e `items.length===3`; `web/movie-suggestions.css`: três colunas | O servidor/modelo já aceitam até 12, mas a sessão visual reduz a lista a três. |
| `lib/shared-cache-worker.mjs`, `sanitizeSharedCatalog` | Conserva nome, ano, gênero, grupos/categorias, nota, IDs e arte; aceita `imdbId` e `tmdbId` válidos. Descarta `collectionId`, `belongs_to_collection`, título original e universo. |
| `supabase/functions/arkhen-catalog-sync/wplay-http.mjs`, `normalizeItems` | Conserva IMDb/TMDB quando a origem fornece esses campos; gênero é derivado das tags. Não há coleção. A presença real dos IDs nos títulos afetados não foi consultada. |
| `lib/wplay-provider.mjs`, `normalizeItems` | O leitor nativo local conserva título/ano/tags, mas hoje não promove nem IMDb/TMDB ao item normalizado. Não presumir cobertura equivalente à coleta Edge. |
| `supabase/functions/arkhen-backend/handler.mjs`, `metadataKeys` | A capacidade administrativa não aceita `collectionId` nem `belongs_to_collection`; adicionar o campo apenas no chamador não o publica. |
| `20261015164720_arkhen_catalog_query_models.sql` | Há campos compactos por item: `query_name`, `query_genres`, ano, nota e identidade textual. Gênero é taxonomia reconhecida, não franquia. |
| `20261015164721_arkhen_home_library.sql`, `arkhen_home_title_identity` | A identidade atual é título normalizado mais ano, retirando sufixos de qualidade/idioma; não resolve traduções nem identifica uma franquia. |

`tmdbId` e `imdbId` identificam uma obra. Não são IDs de coleção. `categoryId` é uma categoria do provedor; `custom_collections` é biblioteca pessoal. Nenhum deles pode ser reinterpretado como coleção de filmes. Ausência de coleção é `unknown`, não uma coleção com valor zero.

## Quatro identidades separadas

1. `workKey`: mesma obra, para excluir a origem e deduplicar edições SD/HD/4K ou dubladas/legendadas. Preferir TMDB de filme ou IMDb válido; sem ID, usar título normalizado e ano conhecido. Um conflito entre IDs confiáveis impede deduplicação só pelo título. Não retirar números de continuações, algarismos romanos, parte ou subtítulo.
2. `collectionKey`: coleção exata, com namespace da origem, por exemplo `tmdb-collection:<id>`. Usar apenas metadado explícito ou associação curada com fonte. A documentação [de detalhes de coleção do TMDB](https://developer.themoviedb.org/reference/collection-details) trata a coleção como recurso próprio; não autoriza derivá-la do ID do filme. A integração atual não fornece essa chave.
3. `franchiseKeys`: famílias editoriais explícitas, por exemplo `batman`, `spider-man`, `fast-furious` ou `transformers`. Podem abranger diferentes coleções e adaptações do mesmo personagem. A associação deve registrar método e versão do registro de aliases.
4. `universeKeys`: agrupamento editorial conhecido, por exemplo `dc` ou `marvel`. Isso não afirma continuidade cinematográfica compartilhada: Batman de adaptações diferentes não se torna automaticamente DCU; todo Homem-Aranha não se torna automaticamente MCU.

Uma obra pode ter mais de uma família em crossover comprovado. Nunca propagar essa associação por transitividade: um crossover com dois heróis não torna todas as franquias de ambos uma única franquia.

## Resolução conservadora

Resolver por ordem de evidência: IDs e associação explícita confiável, registro curado de IDs, título completo/ano curado e, por último, alias de locução distintiva com limites de palavras. Não usar sinopse, nomes de atores, diretor, distribuidora, capa, nota ou gênero para afirmar franquia/universo.

A normalização pode remover acentos, caixa, pontuação equivalente, ano terminal e os sufixos técnicos já reconhecidos. Deve conservar números da história, nomes e subtítulos. `Spider-Man`, `Spider Man` e `Homem-Aranha` admitem aliases específicos; isso não permite normalizar qualquer ocorrência de `spider` para Homem-Aranha. Escape dos aliases deve ser literal, sem regex fornecida por cliente.

Se uma expressão corresponder a duas famílias incompatíveis, deixar sem resolução. Se um ID confiável contradisser o alias de título, o ID prevalece e o conflito não gera uma segunda associação. Um resultado por palavra não pode sobrescrever uma identidade explícita. Documentários, making-of e paródias não recebem o vínculo da franquia apenas por mencionar o personagem no título.

Limites sugeridos para a primeira implementação: registro estático versionado no banco, no máximo 64 famílias, 32 aliases por família, cada alias até 100 caracteres; título normalizado até 500 caracteres; até quatro franquias e dois universos por obra. Esses são limites propostos, não medidas de cobertura ou capacidade. Registro não pode ser alterado pelo corpo da requisição privada.

## Sementes iniciais

As linhas abaixo são sementes de regras; não garantem que a obra esteja publicada ou disponível. Aliases de locuções aceitam pontuação e tradução indicadas. Títulos completos sem locução distintiva exigem registro exato, preferencialmente ano ou ID; não viram palavras soltas de busca.

| Família | Aliases positivos iniciais | Limite ou ambiguidade |
| --- | --- | --- |
| `batman` → `dc` | `Batman`; locuções `The Batman`, `Batman Begins`; títulos completos `The Dark Knight`, `The Dark Knight Rises`, `O Cavaleiro das Trevas`, `O Cavaleiro das Trevas Ressurge` | Não reconhecer `dark`, `knight`, `trevas`, `Gotham`, `DC` ou ator isolados. Excluir documentários/paródias sem associação curada. A [página oficial de The Dark Knight](https://www.dc.com/movies/the-dark-knight-2008) comprova a ligação com Batman; a [ficha de Batman](https://www.dc.com/characters/batman) comprova o agrupamento DC. |
| `spider-man` → `marvel` | Locuções `Homem-Aranha`, `Spider-Man`, `The Amazing Spider-Man`, `O Espetacular Homem-Aranha`; aliases completos dos títulos do Aranhaverso | Não usar `aranha`, `spider`, `home`, `man` ou nome do ator. A [ficha oficial do personagem](https://www.marvel.com/characters/spider-man-peter-parker/) fornece o vínculo Marvel; a associação editorial não distingue a continuidade de cada adaptação. |
| `fast-furious` | `Velozes e Furiosos`, `Fast and Furious`, `The Fast and the Furious`; títulos completos `2 Fast 2 Furious`, `Fast Five`, `Furious 7`, `The Fate of the Furious`, `F9`, `Fast X`, `Hobbs & Shaw` | Não usar `fast`, `furious`, `velozes`, `carros` ou `X` sozinhos. `F9` e `Fast X` só exatos/ano/ID. O [filme Hobbs & Shaw](https://www.universalpictures.com/movies/fast-furious-presents-hobbs-shaw) é associado oficialmente à franquia; [Fast X](https://www.universalpictures.com/movies/fast-x/posters?asset_id=3112) é descrito como parte da saga. |
| `transformers` | `Transformers`; título completo `Bumblebee` | `Bumblebee` só exato e curado, não qualquer referência à palavra. Não usar `robot`, `robô`, `rise`, `origem`, `prime` ou ator. A [coleção oficial da Paramount](https://www.paramountmovies.com/collections/bumblebee-transformers-6-movie-collection) associa Bumblebee aos filmes Transformers. |
| `avatar-cameron` | `Avatar` com ano 2009 em registro exato; `Avatar: The Way of Water` / `Avatar: O Caminho da Água`; `Avatar: Fire and Ash` / `Avatar: Fogo e Cinzas` | `Avatar` sem ano/ID/coleção permanece não resolvido. `Água`, `fogo`, `Pandora`, `azul`, `Aang` ou diretor não são aliases isolados. O [catálogo oficial Avatar](https://www.avatar.com/movies) e a [página de The Way of Water](https://www.avatar.com/movies/avatar-the-way-of-water) sustentam essa família. Não usar cronograma futuro para afirmar existência no catálogo. |
| `avatar-aang` | Títulos completos `The Last Airbender`, `O Último Mestre do Ar`, `Avatar: The Last Airbender`, `Avatar Aang: The Last Airbender`; demais traduções somente curadas | Não usar `Avatar`, `Aang`, `air`, `ar` ou `mestre` isolados. A [página oficial da Paramount](https://www.paramountmovies.com/movies/avatar-aa) identifica Aang e The Last Airbender. `avatar-aang` e `avatar-cameron` são incompatíveis mesmo na etapa de preenchimento por gênero. |

Para ampliar DC/Marvel além do personagem selecionado, é necessário um conjunto positivo para os candidatos também. Ser filme de ação, ter super-herói, vir de uma categoria chamada Marvel/DC ou conter `homem` não basta. Famílias adicionais como Superman, Wonder Woman, Aquaman, Avengers, Iron Man e Captain America exigem aliases completos/IDs e fontes no mesmo registro; não herdam universo por semelhança textual.

Termos curtos ou comuns como `It`, `Us`, `Up`, `X`, `Her`, `Alien`, `Saw`, `Venom`, `Flash` ou `Cars` precisam de título completo com ano/ID e uma entrada explícita. Não criar regras `contains`, prefixos de duas letras ou busca no texto completo. Uma regra mais restrita pode perder um vínculo; isso é preferível a promover outro filme a continuação por acidente.

## Ordem calculada na RPC

Usar classes lexicográficas, sem uma soma arbitrária que permita nota/histórico superar uma continuação:

1. Mesma coleção explícita, excluindo a mesma obra.
2. Mesma franquia curada, excluindo incompatibilidades.
3. Mesmo universo editorial comprovado para origem e candidato.
4. Gêneros reconhecidos em comum; interseção proporcional pode desempatar gêneros muito amplos.
5. Categoria específica confiável do provedor, nunca plataforma/qualidade/Lançamentos.
6. Afinidade de gênero do histórico privado e, por último, nota como recomendação geral.

Dentro de coleção/franquia, favorecer continuidade conhecida e proximidade à origem; não assumir sequência pelo ID do provedor ou retirar números do título. Quando não houver ordem curada, usar ano de lançamento e nota apenas como desempates explícitos, com ID estável no final. Respeitar a política atual de títulos já vistos, mas confirmar com produto se continuações vistas devem continuar excluídas: a proposta não muda silenciosamente essa regra.

A consulta deve selecionar os vínculos fortes antes de limitar o pool genérico de 600, deduplicar por `workKey`, aplicar adulto/ocultação/geração/conta e devolver até 10 na ordem final. Se houver menos candidatos válidos, devolver menos; não inventar disponibilidade nem duplicar edições para preencher a grade. O universo oposto de Avatar permanece excluído mesmo ao completar a lista por gênero ou nota.

Conservar RLS e `SECURITY INVOKER`, JWT do usuário, partição, geração visível, limite máximo, orçamento de consulta e histórico privado. O navegador não manda `collectionKey`, família ou universo como autorização ou verdade. Não fazer uma RPC por card nem consultar TMDB/provedor a cada abertura de prévia. Resolver identidades globais uma vez por publicação/versão do registro sempre que possível; não criar classificação por usuário.

Uma implementação transitória pode aplicar o registro SQL aos campos compactos existentes, com limites explícitos e revisão do custo. O modelo por geração pode materializar memberships de coleção/franquia/universo, seguindo `catalog_navigation_cache`; isso evita varrer JSON grande e todos os aliases em cada consulta. Não é necessário um serviço de embeddings ou um novo motor de recomendação. Não adicionar uma coluna gerada que reescreva todo o catálogo sem avaliar o custo da publicação.

## Resposta e cliente

Manter `schemaVersion:1`, `sourceId`, `revision`, `revisionLibrary`, `generatedAt`, `personalized` e `items` ordenados. Acrescentar uma versão de ranking/registro para invalidar cache compatível. `reason` pode admitir `source_collection`, `source_franchise` e `source_universe`; em uma lista mista, não afirmar que todos os dez são da mesma franquia. Uma explicação por item é mais fiel; o frontend pode usar um título neutro enquanto não a exibe.

`personalized` continua dependendo de influência real do histórico da conta. Uma família derivada do filme aberto é contextual, não personalização por usuário. A resposta não expõe histórico bruto, IDs privados ou dados de outra partição.

O pedido atual de ranking totalmente na RPC substitui os caminhos antigos de ranking local em `lib/filmes/recomendacoes-sessao.mjs` e `web/filmes/sugestoes/catalogo-carregado.js`. Em falha da RPC, conservar somente uma resposta anterior compatível com conta/filme/geração/filtros/versão ou mostrar indisponibilidade com nova tentativa. Não executar o classificador no navegador, não reordenar por nota/gênero local e não converter falha em vazio bem-sucedido.

O cliente pede e mostra dez, mantém a ordem da resposta e monta cinco colunas no espaço adequado, com redução responsiva em telas estreitas. Prévia e fim do filme podem compartilhar o cache da mesma consulta e conservar tickets de cancelamento separados. O novo layout não muda autoplay, reprodução, progresso ou biblioteca.

## Integração mínima sugerida

- Banco: resolução versionada e ranking por classes dentro de `arkhen_movie_recommendations`, mantendo filtros e deduplicação; identidades fortes não dependem do corte de nota.
- Servidor: transportar a lista da RPC e indisponibilidade com os mesmos guards; retirar os dois fallbacks que hoje fazem ranking em memória quando esse novo contrato for integrado.
- Cliente: sessão/modelo pedem até dez; visualização preserva a sequência e adota cinco colunas em desktop. Nenhum ranking local substituto.
- Futuro metadado explícito de coleção: validar namespace/ID nos dois normalizadores, sanitizador e allowlist antes de publicar. Não inventar o valor a partir de `tmdbId` e não baixar VOD para obtê-lo.

Fontes locais principais: migration de recomendações de 15/10, migrations de query models e Home identity, `lib/filmes/`, `lib/shared-cache-worker.mjs`, `lib/wplay-provider.mjs`, `supabase/functions/arkhen-catalog-sync/wplay-http.mjs`, `supabase/functions/arkhen-backend/handler.mjs`, `web/filmes/sugestoes/` e `web/filmes/tanstack-query.js`. Fontes oficiais foram consultadas somente para verificar as sementes editoriais descritas; não houve consulta de conta, catálogo remoto ou disponibilidade de mídia.
