# Limite de falhas da consulta privada da Home

Data: 16/10/2026. Estado: correção local com revisão e checagens estáticas; sem testes, navegador, reprodução ou confirmação de recuperação da RPC remota.

`HomeCloudModel` limitava novas tentativas por `failedRevision`. A revisão inclui `homeLibraryRevision`, que muda ao salvar ou sincronizar progresso. Depois de esgotar os backoffs de uma falha, o próximo avanço de progresso criava uma revisão diferente e voltava a solicitar `/api/home/library`, respeitando somente a margem de 15 segundos. Isso permitia repetir a consulta indefinidamente enquanto a causa do 503 persistia.

O orçamento agora pertence ao escopo da consulta, incluindo conta, geração da conexão, partição, proteção e ocultações. Uma chamada inicial pode agendar no máximo três backoffs. Ao esgotar o orçamento ou receber erro não recuperável, `blocked` impede requisições e timers novos, independentemente da revisão de progresso ou catálogo. `reset()` continua cancelando a consulta, limpando a projeção privada e o cache; se o escopo for o mesmo, ele não repõe esse orçamento.

Uma tentativa manual com `ensure({force:true})`, recuperação explícita validada de conexão ou mudança real de escopo libera novas tentativas. O caminho já existente de `HomeRealtime.statusChanged` usa `force` ao passar de offline/connecting/restricted/local para synced. A sincronização normal de progresso não usa `force`; o ciclo syncing → synced não reabre o circuito.

Uma resposta válida zera o orçamento e mantém a atualização por revisão. Alterações recebidas durante uma consulta bem-sucedida ainda agendam a revisão seguinte. Falha no mesmo escopo conserva o último snapshot válido; conta ou proteção diferentes cancelam respostas antigas e descartam a projeção anterior. O módulo não altera autorização, ranking, JWT, RPC ou biblioteca e não substitui indisponibilidade por recomendações calculadas no cliente.

Fontes: `web/inicio/tanstack-query.js`, `web/inicio/realtime.js`, `web/inicio/orquestrador.js` e os chamadores `persistHistory`, `ensureHomeProjection` e `updateCloudStatus` em `web/app.js`. A causa do 503 remoto deve ser diagnosticada separadamente; impedir o ciclo automático não prova disponibilidade do banco.
