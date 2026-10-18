# Recuperação da Home TV e das sugestões de Filmes

Data: 16/10/2026 local, 17/10 UTC. A análise partiu das três capturas enviadas pelo usuário. Foram reunidas quatro frentes: recomendações de Filmes, TV/identidade, pesquisa externa e revisão independente. Na primeira etapa, testes, navegador do projeto, requisições funcionais e reprodução não foram executados. A investigação posterior autorizada está registrada abaixo.

## Achados da reunião

- A imagem de Filmes registra HTTP503, sem o código interno ou a duração correspondente. Isso não demonstra, sozinho, que o ranking causou a falha. A imagem da Home registra `CLOUD_TIMEOUT` em `arkhen_identity_bind`, cerca de15s, antes da consulta dos quatro canais.
- A RPC instalada de TV usava o total vitalício de `user_tv_watch_time`. Esse total não implementava os últimos sete dias. Não há timestamps suficientes nesse acumulado para reconstruir uma semana de tempo assistido.
- O botão da faixa aguardava `cloudBridge.recover()`, mas o método devolvia `undefined`. A consulta podia continuar antes de terminar a recuperação.
- A passagem comum de Home/Filmes por `client.connect()` podia renovar a autenticação WPLAY após cinco minutos. Projeções privadas agora reutilizam a sessão validada, como a leitura TV existente; status ativo, validade, idade da prova, cliente e geração continuam sendo verificados.
- A seleção de Filmes já considera identidade do nome/franquia/universo, gênero, categoria e histórico; nota desempata a relevância. Os candidatos vêm do mapa da geração, com filtros privados no destino. Não foi criada uma alternativa de ranking no navegador.

## Alterações locais

`lib/filmes/conector-supabase.mjs` compartilha apenas RPCs simultâneas idênticas. Conta, cliente, geração de autenticação, PIN e preferências isolam o trabalho. Cada leitor cancela independentemente; o último cancela o upstream. Não há cache de DTO privado no servidor. Ver [detalhe de Filmes](movies-recommendations-single-flight-20261017.md).

`lib/app-server.mjs` reutiliza a prova existente para as projeções privadas de Home/Filmes. `web/inicio/lista-canais/tanstack-query.js` verifica a idade da última leitura bem-sucedida: após60s, a próxima chamada ativa de `ensure` pode consultar novamente mesmo sem revisão nova. Não acrescenta polling. Falhas continuam conservando o último DTO do mesmo escopo, sob o circuito existente.

A faixa mantém a ordem da RPC: um mais assistido à esquerda e até três recentes distintos, sem completar com favoritos ou canais aleatórios. O CSS existente apresenta quatro colunas em telas largas, duas até950px e uma até360px. O rótulo do destaque informa a janela de sete dias. Não houve inspeção visual em dispositivos nesta rodada.

`CloudAppBridge.recover()` devolve a promessa da conexão existente. Recuperação de bootstrap indisponível começa em30s; o estado pendente conserva5s. Diagnósticos idênticos têm intervalo mínimo de30s. O transporte de `arkhen_identity_bind` passa a no máximo5s, respeitando um prazo customizado menor; as demais RPCs mantêm seus próprios orçamentos.

## Banco aplicado e conferido

As migrations `20261017014444_arkhen_identity_bind_fast_path.sql` e `20261017014445_arkhen_tv_home_rolling_week.sql` foram aplicadas ao projeto autorizado. O vínculo existente passa por uma leitura das identidades/perfil/partição, sem repetir os inserts; a validação da conta e a emissão Auth continuam obrigatórias. A função permanece invoker, exclusiva do serviço, com SQL3s e lock500ms.

A TV usa `arkhen_private.user_tv_watch_buckets`: buckets UTC de uma hora contêm multiranges dos intervalos medidos. Intervalos adjacentes se unem, mantendo tipicamente uma faixa para reprodução contínua. Uma batida credita no máximo20s em até dois buckets. A janela é `[now()-168h, now())`: horas internas usam o total pronto; somente as duas bordas precisam de interseção. A leitura atinge no máximo169 buckets por canal dentro da janela. Ver [operadores PostgreSQL](https://www.postgresql.org/docs/current/functions-range.html).

A limpeza usa a chave do proprietário/partição e exclui no máximo512 buckets vencidos por batida. O marco evita repeti-la antes da hora seguinte quando a página terminou; página cheia continua na próxima batida. Contas inativas mantêm seus buckets antigos até retomarem a atividade ou serem removidas; a consulta semanal sempre exclui esses dados antigos. Não foi criado cron nem feita varredura global de histórico.

O acumulado antigo permanece útil para os recentes, com tempo semanal zero quando não há intervalos datados. O destaque semanal começa com a nova medição; não foi inventado um backfill. A RPC mantém até três recentes distintos, mesmo quando ainda não há destaque semanal.

O retorno administrativo da segunda migration expirou em30s. A operação não foi repetida: o readback posterior confirmou os corpos novos, a tabela com RLS, o índice pronto e ausência de SELECT/INSERT autenticado direto. As RPCs TV continuam autenticadas e inacessíveis ao anônimo; o helper privado é exclusivo do serviço.

| Função | MD5 de `prosrc` confirmado |
|---|---|
| `arkhen_identity_bind` | `a2bfe01c3c14e37bcaa1a8d54b1fa4a1` |
| `arkhen_home_tv` | `06c1fa9c96b9689e2b974b8d1104ee10` |
| `arkhen_tv_watch_heartbeat` | `dc7d9b10e2df7075089faf01ef68465d` |
| `tv_watch_span_milliseconds` | `08633d1d3302d528e2b9b8576e1d43ac` |

As operações reutilizáveis são [inspeção agregada](../supabase/operations/inspect-home-recommendation-functions.sql) e [readback de schema/ACL](../supabase/operations/readback-home-recovery.sql); não executam RPC privada nem retornam biblioteca. O servidor local anterior foi encerrado graciosamente e `node server.mjs` iniciou novamente na porta4173 com as alterações. As sessões de processo anteriores foram encerradas; o navegador precisa recarregar e reconectar. Não houve publicação do site.

## Pesquisa aplicada

As fontes sustentam reduzir candidatos antes de ordenar, preparar relações por geração e evitar repetir a mesma consulta. Elas não demonstram a causa do503 desta sessão nem substituem métricas do ARKHEN.

- [Netflix: Learning a Personalized Homepage](https://netflixtechblog.com/learning-a-personalized-homepage-aa8ec670359a): seleção, filtros, ordenação, deduplicação e adaptação da apresentação.
- [Amazon Science: história do algoritmo de recomendações](https://www.amazon.science/the-history-of-amazons-recommendation-algorithm): relações item-item que podem ser preparadas fora da requisição.
- [TensorFlow Recommenders: Retrieval](https://www.tensorflow.org/recommenders/api_docs/python/tfrs/tasks/Retrieval): obtenção de candidatos como etapa separada do ranking.
- [Recommenders no GitHub](https://github.com/recommenders-team/recommenders): implementações de alternativas simples, incluindo SAR/TF-IDF. Nenhuma dependência foi instalada.
- [PostgreSQL: índices e ordenação](https://www.postgresql.org/docs/current/indexes-ordering.html): `LIMIT` posterior à ordenação não limita, por si só, o trabalho de seleção.

## Estado da evidência

A leitura administrativa foi restrita ao projeto autorizado `wnicimkmzswksaqdtgdv`, usando a ferramenta existente do repositório. Os MCPs com projetos fixos apontavam para outros projetos; o conector de apps não tinha acesso ao projeto ARKHEN. Não houve mutação nesses projetos externos.

O readback inicial confirmou as versões anteriores de HomeTV, heartbeat, bind e recomendações. O bind não tinha limites SQL de statement/lock. A estatística disponível só continha uma execução concluída de identidade,476ms; não havia execução de Filmes/TV para medir a falha das imagens. A inspeção pontual de sessões ativas retornou vazia. Essas observações não certificam saúde contínua nem encerramento do incidente de CPU.

As correções JavaScript foram inspecionadas e verificadas por sintaxe. A revisão independente conferiu isolamento, cancelamento, filtros e validade da sessão. Resultado privado, ganho real de latência e aparência final não foram validados por causa da restrição atual a testes e navegador.

## Investigação posterior e recuperação observada

O usuário autorizou testes internos sem navegador e determinou diagnóstico antes de novas alterações. Três agentes retomaram a investigação. O processo local registrou `CLOUD_SESSION_MISSING`, fase `precondition`, 0ms: a requisição observada não chegou à RPC de recomendações. Auth administrativo estava indisponível às 01:55–01:56 UTC. Às 02:00 UTC os três serviços estavam saudáveis e o início do PostgreSQL mudou para 01:57:24 UTC, comprovando reinício observado, sem atribuí-lo a esta frente.

Às 01:59 UTC, o adaptador configurado respondeu à saúde pública de Auth em495ms e ao lookup de identidade sintética inexistente em275ms, sem emitir sessão. Um login isolado com a configuração local foi recusado pelo provedor; portanto não certificou o fluxo real. Um teste proposto que escolheria perfil privado e simularia claims foi bloqueado pela revisão automática e não executado. A investigação prosseguiu sem esse acesso.

Os testes do endpoint, bootstrap e recuperação com fixtures passaram; uma expectativa antiga de retry5s foi corrigida para o piso deliberado30s, sem mudar o comportamento do aplicativo. A SQL atual até051752 passou18 verificações em PostgreSQL local sobre ranking, nota, Aang/Cameron, filtros e RLS. O usuário enviou novas capturas com sugestões carregadas e confirmou que a faixa de canais também voltou. Nenhuma nova mudança de ranking foi necessária para essa recuperação. Isso não comprova estabilidade prolongada da plataforma.

As capturas também mostraram possível repetição de uma obra com metadados incompletos. A inspeção identificou que identidades com ano conhecido/ausente podem divergir, mas a consulta global destinada a confirmar os dois registros expirou; não foi aplicada correção especulativa de deduplicação. Essa hipótese é separada do503 anterior ao ranking.

O pedido seguinte alterou a faixa para destaque+quatro recentes, com Globo padrão e programação: [implementação e evidências](home-tv-five-cards-20261017.md).
