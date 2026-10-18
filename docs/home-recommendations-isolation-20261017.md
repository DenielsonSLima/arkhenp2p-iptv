# Isolamento de recomendações e canais do Início

Data: 17/10/2026. Estado: duas RPCs aditivas aplicadas no projeto autorizado `wnicimkmzswksaqdtgdv`; conferência de corpo e ACL concluída. Servidor local ativado e integração HTTP com login normal validada. A interface Safari permanece sem verificação remota.

## Evidência desta rodada

O processo local registrou `home-library`, fase `rpc`, `RPC_REQUEST_FAILED`, `CLOUD_DATABASE_TIMEOUT`, PostgreSQL `57014`, HTTP remoto500, após9150ms. Isso comprova cancelamento SQL naquela requisição; não identifica sozinho qual subconsulta consumiu o orçamento. As capturas de sugestões de um filme com503 não permitem atribuir a mesma causa sem a medição dessa RPC.

A consulta administrativa pontual inicial retornou DB/Auth/REST indisponíveis. Um readback posterior, às16:12:38UTC, informou PostgreSQL iniciado às16:12:27UTC; um reinício foi observado, sem execução de restart por esta frente. As estatísticas de execução estavam vazias após esse reinício. A saúde pontual após as migrations retornou `ACTIVE_HEALTHY` nos três serviços. A recuperação da infraestrutura não é atribuída às migrations.

A inspeção administrativa não consultou APIs de logs, perfis, favoritos ou progresso reais, nem simulou claims de uma conta. Retornou apenas metadados de funções, contadores agregados e grupos de sessões PostgreSQL. A validação HTTP posterior usou login normal autorizado e as rotas do próprio produto; os dados pessoais recebidos ficaram somente em RAM, sem cópia neste relatório. Não houve escrita na biblioteca ou execução de mídia.

## Dependência removida

A antiga `arkhen_home_library` exigia `home_identity` pronta em todos os domínios, inclusive TV, antes de retornar recomendações ou histórico de Filmes/Séries. Sua revisão privada também avançava com progresso de TV. O teste local reproduziu a falha: um canal em preparo fazia a função inteira retornarNULL.

A nova `arkhen_home_vod` restringe preparação, gerações, categorias, progresso e favoritos a Filmes/Séries. Conserva o ranking, a ordem, os filtros e as contagens VOD. Por compatibilidade de DTO, entrega `counts.live=0`, `history.live=[]` e `favoriteChannels=[]`. A RPC antiga permanece para clientes anteriores. O isolamento reduz trabalho e remove uma dependência incorreta; não é prova de que a consulta anterior sempre expirava nessa etapa.

Os canais passam pela entrada `arkhen_home_tv_catalog`, que deriva apenas IDs da geração publicada de TV no banco. O Node não precisa transferir todo o catálogo antes de pedir cinco cards. O ranking final, a disponibilidade, o conteúdo adulto e as ocultações continuam validados por `arkhen_home_tv`. A RPC não altera o heartbeat nem concede autoridade para reprodução.

As sugestões da obra aberta continuam em `arkhen_movie_recommendations`, com identidade/ranking próprios. Não foi alterada sua ordenação nem criado ranking alternativo no navegador. Os três contratos estão documentados em [pastas separadas](../supabase/domains/README.md), sem cópias divergentes dos corpos SQL.

## Publicação e segurança

Arquivos criados pela CLI2.108.0 e aplicados via ferramenta administrativa restrita ao projeto:

| Migration | RPC | MD5 de `prosrc` remoto/local |
| --- | --- | --- |
| `20261017161601_arkhen_home_vod_isolated.sql` | `arkhen_home_vod` | `10e0aac1e02c7d17d728dc210f533a86` |
| `20261017161618_arkhen_home_tv_catalog_authority.sql` | `arkhen_home_tv_catalog` | `78c70a79c8581bfd8ee7d3f93293169d` |

Ambas são `SECURITY INVOKER`, `search_path=''`, execução autenticada e recusa anônima. Os orçamentos existentes permanecem oito segundos VOD e três segundos TV. A implementação interna anterior de HomeTV mantém seu `SECURITY DEFINER` com guardas explícitas; não houve promoção de novas funções a definer, alteração RLS, grant de tabela, novo cron ou publicação de dados privados.

Readback confirmou os hashes anteriores de `arkhen_home_library`, `arkhen_home_tv` e `arkhen_movie_recommendations` inalterados. Operações reutilizáveis: [inspeção limitada](../supabase/operations/inspect-private-projection-health.sql) e [conferência das RPCs](../supabase/operations/readback-home-domain-isolation.sql).

## Verificação e limites

O harness `tools/test-home-library.mjs` passou141 asserções em PostgreSQL local/PGlite com contas e catálogos sintéticos. A nova fixture comprova preservação de recomendações/históricos VOD, contagens, independência entre gerações, revisão privada VOD não alterada por TV, filtros de disponibilidade/adulto/ocultação e recusa anônima/partição alheia. Ela também reproduz a indisponibilidade anterior provocada por TV sem preparo.

Essas asserções e a publicação não medem latência da sessão real nem certificam a interface do Safari. Não aumentar prazos nem declarar resolvido o503 de sugestões com base apenas no sucesso de schema. A conclusão funcional exige respostas reais das três rotas integradas.

## Validação HTTP posterior

Uma instância temporária na porta4174 carregou os conectores novos sem interromper o processo usado pelo Safari. Login normal autorizado respondeu200 em1545ms e bootstrap `ready`. Na mesma sessão, sem tokens artificiais ou acesso administrativo a dados pessoais:

| Rota | HTTP | Tempo observado | Contrato verificado |
| --- | --- | --- | --- |
| `/api/tv/home` | 200 | 550ms | DTO próprio, cinco cards |
| `/api/home/library` | 200 | 2612ms | DTO VOD, componentes de TV vazios |
| `/api/recommendations/movie` | 200 | 3213ms | DTO próprio, dez sugestões |
| `/api/catalog/revision?type=live` | 200 | 118ms | Cabeçalho compacto |

São amostras únicas de consulta, não tempo de abertura do vídeo nem garantia de disponibilidade contínua. A instância foi encerrada após as leituras e nenhuma credencial/cookie/URL de mídia foi persistida. O controle remoto do Safari voltou a retornar `Sky Computer Use native pipe startup failed`; não houve validação visual nessa etapa.

No código do cliente, VOD usa `web/inicio/biblioteca/`; sugestões da obra ficam em `web/filmes/recomendacoes/`. Conta, partição, filtros do domínio e epoch delimitam a reutilização. Falhas503 preservam a última resposta válida dentro desse escopo; alterações de TV não cancelam consultas VOD. A configuração geral deixou de zerar a Home inteira: os escopos decidem qual módulo precisa ser renovado.

## Ativação e rodada integrada final

172 testes de HTTP, isolamento, estados do cliente, navegação EPG, publicação e cancelamento passaram. O bundle de `web/app.js` foi compilado em memória, sem trocar os artefatos distribuídos. A revisão independente encontrou e confirmou a correção de uma corrida de invalidação EPG; os detalhes estão em [cache de programação](tv-guide-memory-cache-20261017.md). A geração das publicações também teve [um timer preso corrigido](catalog-publication-generation-20261017.md).

O processo local na porta4173 foi reiniciado uma vez para ativar esta etapa. Login normal retornou200/ready em1687ms. HomeTV200/428ms; HomeVOD200/1405ms; sugestões de filme200/4211ms. As três revisões compactas retornaram200: TV207ms, Filmes207ms, Séries479ms. O teste encerrou apenas a própria sessão criada; não alterou favoritos/progresso.

A consulta EPG para cinco canais retornou200/451ms. A captura compartilhada estava marcada `stale`; duas leituras posteriores, separadas por5,5s e a segunda com `fresh=1`, retornaram200/121ms e200/79ms. Ambas continham programa atual para os cinco canais, mas conservaram a marca de captura antiga, com idade aproximada de36,8h. Isso impede classificar a origem EPG como atualizada somente peloHTTP200. Cache e consultas funcionais não corrigem automaticamente falhas de coleta da origem.

A [inspeção posterior da publicação EPG](epg-publication-expired-20261017.md) confirmou captura com TTL vencido, horizonte ainda válido e último job falho com `ECONNRESET`. Cron ativo e próxima cadência não comprovam sucesso da coleta; não houve disparo ou alteração de agendamento nesta etapa.

Rollback operacional: trocar os conectores de volta para `arkhen_home_library` e para a chamada antiga `arkhen_home_tv` com IDs validados. Os corpos antigos foram preservados; não há dados a restaurar. Remover as RPCs aditivas só é necessário se nenhum cliente atual as usar, em migration posterior revisada.

Referência de segurança: [documentação oficial de funções Supabase](https://supabase.com/docs/guides/database/functions). A consulta do índice de changelog emMarkdown não foi disponibilizada pelo navegador da ferramenta; nenhuma convenção de API ou SDK nova foi introduzida.
