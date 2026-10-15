# Recomendações de filmes calculadas no Supabase

A prévia de um filme e a tela ao terminar usam a mesma consulta privada: `POST /api/recommendations/movie`. O servidor recebe `{id, limit, hidden, hiddenItems}`, aceita de 1 a 12 resultados (padrão 3) e obtém provedor, partição e JWT da sessão autenticada. Nenhum identificador de usuário nem autorização para conteúdo adulto é aceito do navegador.

O PostgreSQL executa `arkhen_movie_recommendations(p_provider_key, p_scope_hash, p_source_id, p_limit, p_hidden_categories, p_hidden_items)`. A função é somente leitura, `SECURITY INVOKER`, mantém RLS e limite de 8 segundos. Não cria jobs, não grava preferências globais nem usa a chave administrativa. O gateway administrativo não recebeu permissão para essa RPC; o transporte existente envia a chave pública e o JWT do próprio usuário diretamente à API do banco.

## Resultado e critérios

O retorno contém `schemaVersion`, `generatedAt`, `sourceId`, `revision` (geração publicada de filmes), `revisionLibrary`, `personalized`, `reason` e `items`. Os itens são metadados de filmes, sem registros brutos de histórico nem identificadores de conta.

| `reason` | Evidência usada |
| --- | --- |
| `source_genre` | Gênero real compartilhado com o filme de origem |
| `source_category` | Categoria específica do provedor compartilhada com a origem |
| `history_genre` | Gêneros presentes no histórico privado da conta |
| `rating` | Ordem por nota quando faltam vínculos anteriores |
| `unavailable` | Origem ausente, oculta ou adulta; nenhum item é retornado |

Categorias genéricas, como Filmes, Geral e Lançamentos, não são tratadas como afinidade. Elas continuam permitindo o retorno por nota. O ranking prioriza gêneros da origem, categoria específica, afinidade do histórico e nota. Até 100 títulos recentes fornecem pesos de gênero por recência; vários episódios da mesma série não multiplicam o sinal. `personalized` só fica verdadeiro quando os resultados efetivamente têm afinidade com esses sinais privados.

Todos os filmes já vistos são excluídos por ID e identidade normalizada de título/ano, além da origem e suas variantes de qualidade. Conteúdo adulto é excluído sempre, mesmo com PIN desbloqueado, usando coluna, categorias confiáveis e marcadores positivos dos metadados. Ocultações e a geração publicada também são respeitadas.

## Custo e cache

A consulta reutiliza `catalog_navigation_cache`, já preparado por geração: a ordem por nota e as associações de gênero/categoria são globais, enquanto o cálculo com histórico ocorre apenas dentro da consulta do usuário. Ela percorre os arrays compactos desse modelo, seleciona até 600 IDs e consulta o catálogo pela chave completa, incluindo geração. Metadados são carregados somente para até 60 candidatos; a resposta contém no máximo 12.

Esses limites reduzem o trabalho por chamada, mas não são uma medição de latência de produção. O plano ainda precisa ser medido com JWT no projeto recuperado; especialmente a expansão dos arrays e as políticas do histórico. Não foi aumentado nenhum limite global nem desativada nenhuma política.

O cache da resposta pertence à conta e deve incluir origem, revisões de catálogo/biblioteca e filtros. Uma falha conserva somente o último resultado compatível. Se a geração ainda não possui modelo preparado, a RPC retorna `null` e a rota responde `503/MOVIE_RECOMMENDATIONS_UNAVAILABLE`; indisponibilidade não é convertida em lista vazia bem-sucedida. Logout e mudança de proteção invalidam respostas em voo. Não consultar em cada quadro ou `timeupdate`.

## Validação e estado de publicação

A migração `20261015192346_arkhen_movie_recommendations.sql` foi criada pela CLI e está preparada localmente. **Aplicação remota não comprovada**: a consulta oficial de saúde em 15/10/2026 às 19:20:44 UTC retornou `UNHEALTHY` para banco, Auth, REST e Storage. Às 19:28:43 UTC, banco e REST apareceram saudáveis, mas Auth e Storage continuaram indisponíveis. Um `SELECT 1` respondeu em 5,7 segundos. A tentativa de aplicação retornou HTTP 400; o wrapper local de registro da migração foi corrigido, preservando o SQL validado, e não foi reenviado durante a falha. A leitura seguinte de existência da função e do histórico voltou HTTP 544. Às 19:32:20 UTC os cinco serviços estavam `UNHEALTHY`; a última verificação somente leitura, limitada a 15 segundos, não recebeu resposta HTTP. Nenhuma causa de recurso, conexão ou plano foi comprovada por esse diagnóstico. A função não pode ser apresentada como disponível em produção enquanto aplicação e leitura real não forem comprovadas.

O fixture `tools/test-home-library.mjs`, incluindo `tools/test-movie-recommendations-fixture.mjs`, passou com 89 asserções PostgreSQL/RLS. Cobre afinidade entre origem e histórico, contas distintas, origem e categorias adultas, metadados adultos inconsistentes, filtros, variantes, vistos, geração não publicada, preparação ausente, limites e permissões. Os 9 testes de `tests/catalog-search-api.test.mjs` passaram e cobrem o contrato HTTP, JWT, ausência de credenciais privilegiadas, validação, indisponibilidade e logout durante consulta.

A RPC da página inicial permanece a existente, documentada em [home-library-rpc.md](home-library-rpc.md). A nova consulta de filme não substitui nem limita a prateleira geral de recomendações.

Referências oficiais: [funções do banco](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) e [otimização de consultas](https://supabase.com/docs/guides/database/query-optimization).
