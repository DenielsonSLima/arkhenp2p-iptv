# Falhas transitórias de Auth e recomendações

Data:18/10/2026. Estado: publicado no commit523c8b1, produção READY; revisão estática e metadados, sem confirmação funcional. Sem testes, navegador, login ou mídia.

As capturas mostram504 de `/auth/v1/user` do Supabase e503 da revisão de catálogo. O erro CORS do Safari acompanha a resposta504 e não comprova origem bloqueada. O ranking de Filmes continua exclusivamente na RPC; não foi criada seleção alternativa no frontend nem alterado orçamento SQL. Esses sinais não isolam a fase da RPC de sugestões.

`CloudLibrary` contém falhas transitórias por identidade completa com intervalo progressivo30/60/120/240/300s. Não repetegetUser durante esse intervalo; a ponte respeita o próximo prazo inclusive com bootstrapready. Êxito e logout explícito limpam a espera.401/403 confirmados conservam o fluxo de rejeição; errotransitório não apaga a sessão.

O modelo de sugestões contém novas tentativas automáticas por conta/filtros/filme, preservando os cards válidos da mesma seleção. Recuperaçãoautomática respeita cooldown; clique explícito pode retentar503, mas429 respeitaRetry-After. Cancelamento do usuário não é erro; expiração do orçamento de transporte é504. Nenhuma repetição a cada render ou posição salva foi acrescentada.

Uma leitura remota limitada encontrou serviçosDB/Auth/REST saudáveis, nove conexões e zero temporários, mas outra consulta administrativa terminou com connectiontimeout. Isso confirma intermitência de acesso e não certifica o ranking privado nem CPU. Leitura posterior às13:51:23UTC encontrou início do postmaster às13:45:24UTC(10:45:24BRT), seis crons ARKHEN ativos e nenhum SQL da aplicação ativo na amostra. Não identifica quem iniciou o banco nem prova a causa de cada504. Métricas de sistema403; esta investigação não executou consultas de logs, restart ou alteração de crons.

Fontes:`web/cloud-library.js`, `web/cloud-app-bridge.js`, `web/filmes/recomendacoes/{modelo,sessao}.js`, [cache estável de revisões](catalog-revision-stable-cache-20261018.md). O problema remoto não pode ser declarado resolvido somente pelo backoff.
