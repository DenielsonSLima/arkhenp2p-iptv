# Organização de Filmes — 16/10/2026

Estado: código local integrado, RPC instalada no projeto autorizado e conferência estrutural remota. Reprodução, interface e ranking na sessão real não foram executados pelo agente; a validação funcional permanece com o usuário.

## Estrutura canônica

`web/filmes/orquestrador.js` compõe a aba e seus leitores sobre o repositório existente. Serviços, escopo, Supabase, TanStack, Realtime, favoritos e progresso ficam em arquivos próprios. Prévia, título e duração têm implementações separadas. `recomendacoes/` contém contrato, estado e apresentação das sugestões. Resolução, buffer, áudio, legenda e reprodução possuem políticas específicas, consumidas pelo player compartilhado.

O [README do navegador](../web/filmes/README.md) descreve cada arquivo. O [mapa do player](movies-player-modularization-20261016.md) registra o uso do mesmo vídeo, HLS, grafo de áudio, controlador de seek e retomada. Metadados ausentes não viram duração ou resolução estimadas. Fontes nativas mantêm os recursos que o navegador expõe; variantes de qualidade só aparecem quando realmente oferecidas.

`lib/filmes/orquestrador.mjs` recebe as rotas de catálogo, modelo de navegação, detalhes e recomendações de Filmes. Seus serviços, metadados, catálogo e conector Supabase estão separados. O núcleo WPLAY usado também por Séries fica em `lib/vod/catalogo-nativo.mjs`. Proxy, Range, sessão, stop/status, backoff429 e sonda MP4 continuam compartilhados, sem outra conexão ou reprodução. Veja o [backend](movies-backend-modularization-20261016.md).

Favoritos e progresso conservam `movie:<id>` e a conta ativa. O módulo atualiza os mapas locais e chama a ponte existente uma única vez. A ponte continua responsável por Auth, sincronização e fila, inclusive durante bootstrap pendente. O Realtime de Filmes consome os eventos autenticados existentes; não cria outro socket nem recarrega TV/Séries.

Cinco antigas fachadas do navegador foram removidas após atualizar seus consumidores. Os testes históricos tiveram somente imports/contratos adaptados; não foram executados. O ranking legado está fora do grafo público e do endpoint ativo.

## Recomendações e instalação remota

A leitura administrativa, somente de estrutura e contagens do catálogo publicado, confirmou 18.211 registros ativos não adultos, sem IDs TMDB ou de coleção e sem a RPC `arkhen_movie_recommendations` instalada. Isso distinguia o código SQL preparado de uma publicação efetiva; o fallback local podia substituir a RPC ausente.

A migration `20261016042729_arkhen_movie_identity_recommendations.sql` foi aplicada pela API oficial de gerenciamento, fixada no projeto `wnicimkmzswksaqdtgdv`. O retorno concluiu sem erro; a leitura posterior confirmou a função, limite padrão10, execução para `authenticated`, recusa para `anon`, `SECURITY INVOKER` e índice GIN pronto/válido. As seis relações usadas mantêm RLS habilitado. Não houve troca de projeto, nova chave ou alteração de biblioteca pessoal.

O ranking versão2 ocorre na RPC: franquia reconhecida, universo editorial, gênero específico, categoria útil e afinidade do histórico. Nota apenas desempata. Não existe preenchimento aleatório por lançamento ou ranking no navegador. Os [critérios e limites](movies-recommendations-ranking-20261016.md) incluem exclusão entre Avatar/Cameron e Avatar/Aang, deduplicação de obras, filtros e limite de candidatos. Os aliases reconhecem automaticamente títulos nas famílias cobertas; não equivalem a uma base completa de todas as franquias.

A conferência agregada do catálogo encontrou 39 registros classificados como Batman, 12 como Homem-Aranha, 17 Velozes e Furiosos e9 Transformers; esses números incluem possíveis versões da mesma obra. A deduplicação e o histórico reduzem os elegíveis para cada usuário. Há95 registros DC e61 Marvel identificados editorialmente, sem afirmar continuidade narrativa única.

O DTO da RPC limita dez resultados. A apresentação usa cinco colunas em desktop e quatro/três/duas em larguras menores, com capas proporcionais e ordem do servidor. Se houver menos de dez filmes elegíveis, não se inventam itens para completar a grade.

## Conferência

Sintaxe dos módulos, imports, bundles estáticos web/servidor e whitespace conferidos. A criação da função/índice e a classificação agregada foram confirmadas remotamente. Não foi invocado o ranking com JWT de um espectador, nem acessada biblioteca pessoal para simular a conta. Essas verificações não comprovam resultados visuais, latência de reprodução ou estabilidade de mídia. O usuário mantém os testes do produto.

Integração final: 34 módulos/entradas conferidos por sintaxe; bundle web151 módulos e servidor55 módulos, ambos estáticos e não executados. Detalhes usam um escopo de conta/geração/PIN independente do bootstrap tardio da nuvem; publicação invalida o cache sem abandonar a prévia selecionada. Servidor local reiniciado com a configuração existente da engine; a página inicial respondeu HTTP200 em `localhost:4173`, sem login, mídia ou navegação automatizada. O reinício pode exigir novo login porque a sessão local reside na memória.
