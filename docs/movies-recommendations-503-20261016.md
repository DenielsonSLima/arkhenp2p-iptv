# Diagnóstico de 503 nas recomendações e Home

Data: 16/10/2026. Sintoma informado pelo integrador: o usuário recebeu 503 em recomendações de Filmes e Home após instalar a RPC. Esta frente não abriu UI, executou ranking, impersonou conta, leu biblioteca/progresso ou reproduziu mídia.

## Evidência posterior: SQL também excede o orçamento

Após alinhar o transporte, novas requisições reais do usuário retornaram `CLOUD_DATABASE_TIMEOUT`, PostgreSQL `57014`: Home em8266ms e Filmes em8194ms. Portanto o prazoHTTP3s era um defeito confirmado, mas sua correção não resolveu o custo da consulta. As publicações045808/050044 não certificam conclusão nem bom desempenho da RPC.

A revisão conjunta localizou dois problemas: `LIMIT600` posterior à classificação/ordenação ainda obriga avaliar o catálogo amplo; e os operadores `&&` e os classificadores usados nos índices não são `LEAKPROOF`. SobRLS, um índice válido pode não ser elegível nesse caminho. A [documentação PostgreSQL39.5](https://www.postgresql.org/docs/current/rules-privileges.html) explica essa restrição. Não marcar funções comoLEAKPROOF nem retirarRLS para contorná-la.

Home recebeu a migration `20261016051017_arkhen_home_library_bounded_memberships.sql`: limita antes da expansão a seis gêneros e300IDs por grupo/domínio; lê300IDs por ordenação de nota; forma um conjunto de até600candidatos por domínio antes dos filtros finais. O readback de schema confirmou corpo idêntico ao arquivo, função invoker, orçamento8s e permissões preservadas. O índice parcial de preparação pendente já existe/válido. Contagens privadas e exclusões não foram amostradas. Esse readback não mede latência da conta.

## Publicação posterior: mapa pronto e campos compactos

Publicadas as migrations `20261016051752_arkhen_movie_recommendations_snapshot_memberships.sql` e `20261016053123_arkhen_home_library_published_signal_fields.sql`. A primeira tentativa da51752 falhou; leitura posterior confirmou rollback completo. O diagnóstico transacional com rollback localizou57014 no classificador de títulos dentro do preparador global. A versão final evita reconstruir toda a navegação no backfill: acrescenta somente o mapa de identidades aos dois modelos atuais, preservando ordens, gêneros, categorias e created_at.

O GIN existente seleciona os positivos no preparador confiável, fora do caminho privado sujeito à restriçãoRLS descrita acima. Sete raízes cobrem o registro imutávelv2 atual. O mapa `movieIdentityV2` guarda franquia/universo→IDs e `byId`→chaves; o preparador das gerações futuras também foi atualizado. A RPC privada limita IDs antes de buscar linhas por chave completa e usa `byId`, sem classificar novamente centenas de candidatos por fase. A origem é identificada uma vez. Ausência de preparação continua explícita, sem alternativa de ranking no navegador.

Leitura posterior confirmou os dois modelos da geração com version2, complete=true e196 entradas identificadas em33 grupos. Contagens globais de entradas: Batman39, Homem-Aranha12, Senhor dos Anéis6 e Velozes e Furiosos17. Podem existir variantes; esses números não são contagens de obras únicas nem garantias de dez resultados após ocultações e vistos. RPCs permanecem invoker, autenticadas, anônimo recusado e SQL8s; o preparador permanece exclusivo do serviço com45s. Nenhuma biblioteca foi alterada.

A53123 remove outro trabalho global residual da Home: sinais de até100 títulos recentes passam a usar query_genres e categorias das linhas correntes já consultadas. Deixam de procurar cada título dentro dos arrays globais de todos os gêneros. Preserva contagens exatas, limites, histórico, filtros e RLS. A versão51017 sozinha ainda produziu57014; não foi tratada como resolução integral.

Revisão independente e planos sem ANALYZE verificaram estrutura, seleção GIN do preparador e buscas por chave no conjunto limitado. Publicação e preparação global estão confirmadas. Latência e sugestões com a sessão real continuam aguardando a próxima ação do usuário; servidor mantido sem reinício para conservar a sessão.

## Conclusão posterior do integrador e publicação

As requisições reais feitas pelo usuário foram capturadas no processo local: Filmes `RPC_REQUEST_FAILED/CLOUD_TIMEOUT` em3002ms e Home em3003ms, na faseRPC. Não eram respostas SQL vazias nem falhas de forma do DTO. A consulta administrativa somente de estatísticas mostrou uma chamada concluída de Filmes em6528,2ms e36 chamadas de Home com média4707,1ms e máximo7973,2ms, sem retornar parâmetros ou biblioteca. O prazo HTTP3s abortava antes de respostas reais que levavam mais tempo no banco.

Corrigido o orçamento apenas dessas duas projeções: SQL permanece8s; HTTP10s por `lib/private-projection-budget.mjs`; cliente de Filmes12s. Os demais limites de mídia, catálogo e autenticação não foram ampliados. A correção é acompanhada de otimização, não apenas espera maior.

Instaladas e conferidas por readback as migrations `20261016045808_arkhen_movie_recommendations_bounded_phases.sql` e `20261016050044_arkhen_home_library_compact_candidates.sql`. Filmes resolve franquia/universo antes de preparar afinidade global e só calcula histórico se ainda faltar candidato. Home usa o modelo compacto e limita candidatos antes de ler detalhes. Funções continuam invoker, execução autenticada/recusa anônima; os três índices novos estavam prontos/válidos. Nenhuma biblioteca pessoal foi alterada pelo rollout.

Identidade agora é2, incluindo Senhor dos Anéis/Hobbit/Terra-Média via helper e índice novos, sem alterar a função imutável já indexada da versão1. Ranking continua2 e o cache do navegador inclui ambas as versões.

O [circuito da Home](home-recommendations-circuit-20261016.md) também foi corrigido: mudanças de progresso não reabrem tentativas esgotadas. Recuperação real da conexão ou ação manual pode tentar novamente. Filmes recupera uma prévia em erro quando a conexão fica pronta, sem temporizador repetitivo. O bootstrap pendente observado no código é uma causa transitória possível, mas não foi a causa capturada nestas requisições, que alcançaram a RPC e expiraram aos3s.

Servidor local reiniciado com os novos limites e versões. Sintaxe, bundle e whitespace conferidos. O ganho de tempo e o resultado visual posteriores ao rollout dependem das próximas chamadas reais do usuário; não se atribui às estatísticas anteriores o desempenho da SQL nova.

## Evidência operacional

Leitura administrativa somente de schema e agregados, pelo wrapper fixo no projeto autorizado, às **04:46:35 UTC**:

| Domínio | Partições visíveis | Itens ativos | home_identity pendente | Modelo seguro da geração |
| --- | ---: | ---: | ---: | --- |
| TV | 1 | 760 | 0 | presente |
| Filmes | 1 | 18.612 | 0 | presente |
| Séries | 1 | 8.124 | 0 | presente |

As oito assinaturas de funções necessárias existem: recomendações, Home, home_title_identity, query_normalize, query_genres, progress_metadata_adult, progress_catalog_adult e partition_allows. Os tipos compactos são os esperados: `home_identity:text`, `query_genres:text[]`, `query_rating:numeric` e `query_release_year:integer`.

Isso descarta ausência global de modelo/backfill como explicação suficiente naquele instante. A leitura administrativa não certifica que o JWT da requisição passou RLS, que sua partição coincide, que o SQL principal executou, que o DTO chegou válido ou que terminou dentro do deadline. Nenhuma linha de profiles/user_progress foi lida por esta consulta.

## Caminhos de falha identificados (levantamento anterior ao ajuste de prazos)

Na RPC de recomendações, retorno SQL `null` ocorre quando não há navegação nãoadulta da geração ou a origem não tem home_identity. Origem ausente/oculta/adulta retorna um DTO válido com lista vazia; não deveria causar503. A RPC de Home retorna null se houver qualquer home_identity pendente na partição/geração.

O conector também retorna indisponibilidade antes da chamada quando runtime está fechado/desabilitado, falta sessão cloud/token ou a partição é inválida. Depois da chamada, rejeita mudança de conta/cliente/Auth/PIN/abort e DTO incompatível. A fronteira HTTP preserva503 explícito e não faz ranking local.

Naquele levantamento o prazoHTTP ainda era3s. A evidência operacional posterior acima localizou tanto o cancelamentoHTTP quanto, depois de corrigido, o cancelamentoSQL8s. Os demais caminhos abaixo permanecem hipóteses secundárias até serem capturados.

## Diagnósticos implementados

`lib/filmes/conector-supabase.mjs` agora emite `[movie-recommendations]` com `phase/code/elapsedMs` e apenas códigos/status remotos sanitizados. Distingue `CLOUD_DISABLED`, `CLOUD_SESSION_MISSING`, `PARTITION_INVALID`, `RPC_REQUEST_FAILED`, `RPC_RETURNED_NULL` e `RPC_DTO_INVALID`. A mesma falha é limitada a um registro a cada30s por estado. Não registra conta, origem, partição, JWT, payload, biblioteca ou mensagem/detalhe SQL.

`ServicosFilmes` deixa de engolir uma falha inesperada de composição sem registro: informa fase/code/duração, mantém guards e a indisponibilidade da rota. Falhas de transporte esperadas já são classificadas pelo conector. Não foi adicionado login, retry, fallback local ou alteração de autorização.

Um defeito de observabilidade foi localizado em `SupabaseCloud.request`: a regex original de remoteCode começava por letra, descartando SQLSTATE como42501/42703/42883/42601 e preservando apenas certos códigos. O integrador recebeu a correção mínima proposta para aceitar apenas tokens alfanuméricos limitados, sem mensagem/details. Este arquivo compartilhado está fora do ownership desta frente.

## Próxima evidência necessária

O registro da requisição real do usuário permite distinguir timeout de3s, rejeiçãoJWT401/403, erro PostgreSQL/PostgREST, retorno SQLnull ou versãoDTO. Não executar login adicional nem usar outra identidade para simular a conta.

Após autorização do integrador, o SELECT principal extraído da migration foi submetido ao parser/planner por EXPLAIN semANALYZE, com parâmetros autenticados/partição/origem declarados comoNULL tipado. O plano JSON foi produzido com168nós e sem métricasActual: nomes, tipos, operadores e CTEs resolvem no schema consultado. Não houve chamada da RPC, JWT, impersonação ou execução/leitura de linhas da biblioteca. Isso não mede tempo real nem certifica RLS do usuário.

A primeira adaptação do artefato de diagnóstico criou uma ambiguidade entre ANY(array) e ANY(subquery), resultando em42883text=text[]. Os casts explícitos no adaptador preservaram ANY(array), e o plano seguinte passou. A RPC original usa campo record.text[] diretamente; não foi atribuído a ela o erro introduzido pelo adaptador. Nenhum SQL da migration foi alterado por esse diagnóstico.

Foi proposta, sem editar app-server, uma guarda específica para Home/recomendações após as verificações de conta/provedor: se o bootstrap da mesma sessão estápending e não existe token, devolver503CLOUD_BOOTSTRAP_PENDING comRetry-After2s, sem chamar aRPC. O cliente pode conservarDTO compatível e aguardar2→4→8→15s, respeitando conta/epoch/visibilidade. Estado unavailable/disabled não deve ser mascarado como pending; negações/expiração continuam retornando401 antes da guarda. attachCloud já compartilha a operação em andamento e mantém cooldown de30s em falha, sem novo login.

Checagens locais concluídas: leitura dos contratos/SQL, sintaxe dos dois módulos e bundle estático do orquestrador. Sem testes, execução de funções de ranking, escrita SQL remota ou certificação funcional.
