# Recomendações de Filmes: chamadas simultâneas

Data: 17/10/2026 UTC (16/10 no fuso do produto). Estado: implementação local e inspeção estática. Não houve teste, navegador, requisição à aplicação, consulta privada ou reprodução nesta frente.

As imagens do pedido mostram `503` em `/api/recommendations/movie` e falhas de identidade em outra tela. O status HTTP, sem fase/código/duração da requisição correspondente, não identifica se a falha nova está em bootstrap, RPC, preparação do modelo ou validação da resposta. A evidência antiga de timeout SQL não deve ser apresentada como diagnóstico da requisição atual.

O caminho ativo é `OrquestradorFilmes` → `ServicosFilmes` → `ConectorSupabaseFilmes` → `arkhen_movie_recommendations`. `SessionMovieRecommendations` permanece legado sem chamador de produção. Não há ranking do catálogo carregado no endpoint.

A migration `20261016051752_arkhen_movie_recommendations_snapshot_memberships.sql` continua sendo a última definição local da RPC. Resolve o nome com identidade editorial versionada; coleta candidatos dos mapas globais da geração; prioriza franquia, universo, gênero específico, categoria e afinidade privada. A nota desempata relevância. O mapa limita IDs antes do acesso a candidatos e metadados. A recomendação de duas etapas encontrada nas fontes oficiais é compatível com esse desenho, não exige um novo serviço ou consulta externa por card.

O conector passa a compartilhar somente uma RPC ainda em andamento quando conta, cliente, geração de autenticação, estado do PIN, origem, limite e preferências são idênticos. Prévia, finalização e retry simultâneos deixam de multiplicar a mesma consulta. Cada consumidor conserva seu cancelamento: sair da prévia não cancela o leitor da finalização; quando nenhum leitor permanece, o upstream é cancelado. Encerrar o runtime cancela as pendências. A requisição concluída é removida; nenhum DTO privado é conservado como cache no servidor.

Os guards de conta, cliente, autenticação, PIN e abort continuam conferidos antes de entregar a resposta. Transporte/SQL inválido permanece indisponibilidade explícita, sem fabricar lista vazia, alterar ranking ou ampliar prazo. O compartilhamento não atravessa contas ou conexões e não modifica RLS/JWT.

Verificação desta alteração: `node --check lib/filmes/conector-supabase.mjs` e `git diff --check` restrito ao arquivo. Ambas são verificações estáticas, sem prova de latência, disponibilidade remota ou resultado visual. A SQL e os prazos não foram alterados nesta frente; uma nova otimização de plano depende de evidência atual do banco.

Fontes: `lib/filmes/conector-supabase.mjs`, `lib/filmes/servicos.mjs`, `lib/filmes/orquestrador.mjs`, migration citada; [TensorFlow Recommenders: retrieval](https://www.tensorflow.org/recommenders/api_docs/python/tfrs/tasks/Retrieval), [Amazon: histórico do algoritmo de recomendações](https://www.amazon.science/the-history-of-amazons-recommendation-algorithm). As fontes externas foram verificadas pela frente de pesquisa da mesma rodada.
