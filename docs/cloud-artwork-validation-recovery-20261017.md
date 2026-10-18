# Revalidação cloud e falha de capas — 17/10/2026

Estado: correção local com regressões sintéticas verificadas. Este registro não certifica a causa histórica de todos os HTTP 503 nem a estabilidade de TV ao vivo.

## Evidência observada

As capturas do usuário das 11:15–11:16 mostram títulos e categorias visíveis, mas capas em placeholder, com HTTP 503 em `/api/shared-image/…` e `/api/tv/home`. O catálogo já disponível no navegador não comprova que a sessão cloud do servidor continua disponível.

Na inspeção posterior, duas referências de capa das capturas existiam e seus objetos no Storage responderam HTTP 200. O endpoint de saúde Auth também respondeu HTTP 200. São leituras pontuais posteriores ao incidente, sem consulta de logs, e não demonstram o estado desses serviços ou da sessão às 11:15. A sessão observada posteriormente pelo coordenador estava conectada e com cloud `ready`.

O código de `lib/app-server.mjs` exige autorização antes de entregar a capa. `CloudRuntime` depende do vínculo cloud para consultar referência e classificação. Falha nessa etapa pode produzir `CLOUD_ARTWORK_UNAVAILABLE`/503 antes de buscar bytes de um objeto existente. A Home TV também depende da sessão cloud autenticada. Alterar tamanho ou proporção da imagem não corrige esse caminho.

## Defeito reproduzido

Em `lib/cloud-runtime.mjs`, uma nova prova válida do provedor provoca a revalidação `arkhen_validate_account`, mesmo quando o JWT Auth existente ainda tem validade. Antes desta correção, qualquer falha nessa RPC executava `detach`, apagando o vínculo local e revogando o JWT ainda válido. Um timeout de metadados, portanto, podia tornar indisponíveis capas e Home enquanto o provedor seguia conectado.

Uma reprodução sintética confirmou esse comportamento, sem conta real: JWT com validade restante, prova nova e timeout controlado resultavam em vínculo removido e uma revogação. Dez chamadas concorrentes também executavam dez revalidações. Os dois testes de regressão falharam antes da alteração e passaram depois dela.

Isso demonstra um defeito capaz de causar os sintomas. Sem o estado histórico da sessão, não permite concluir que foi o único motivo das capturas.

## Correção e limites

- Revalidações concorrentes do mesmo vínculo compartilham uma única RPC.
- Timeout, indisponibilidade de transporte e HTTP 5xx podem conservar apenas a mesma sessão Auth ainda válida, com prova e conta do provedor válidas. A validade do token e a idade da prova não são prorrogadas.
- Uma falha transitória agenda nova validação com espera de 30, 60 e até 120 segundos. A prova nova não reinicia essa espera.
- Negação 401/403, conta desabilitada/expirada, prova antiga, JWT expirado ou erro inesperado continuam sem essa tolerância.
- Identidade, geração de autenticação, época da sessão e expiração capturada impedem que resposta antiga reverta logout, negação ou recuperação Auth em andamento.
- O bootstrap de um token expirado continua com seu contrato anterior. Não foi feita alteração em schema, funções remotas, políticas RLS, credenciais ou player.

Validação: `tests/cloud-validation-recovery.test.mjs`, `tests/cloud-runtime.test.mjs` e `tests/wplay-connection.test.mjs`: 41 testes aprovados. Sintaxe de `lib/cloud-runtime.mjs` e `git diff --check` passaram. Os testes usam relógio e transporte sintéticos; não medem reprodução real. Esta frente não reiniciou o servidor do usuário nem ativou o código no processo em execução.

Fontes: `lib/cloud-runtime.mjs`, `lib/app-server.mjs`, `lib/supabase-cloud.mjs`, testes citados e capturas fornecidas em 17/10/2026. Leituras remotas limitadas à saúde e à existência das referências/objetos, sem dados de conta neste documento.

Atualização do coordenador em 17/10, conferida às 13:00 BRT: backend local reiniciado uma vez com autorização explícita do usuário, ativando esta correção junto à associação de HBO Plus e ao código `SESSION_REQUIRED`. Página e respostas anônimas foram conferidas. O controle remoto do Safari estava indisponível; recuperação de capas em sessão real após o reinício não foi certificada. Detalhes em [associação de canais](tv-channel-mapping-codec-20261017.md).
