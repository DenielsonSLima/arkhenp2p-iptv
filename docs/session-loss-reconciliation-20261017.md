# Sessão encerrada com interface ainda conectada

Data: 17/10/2026. Estado: mecanismo reproduzido, correção local testada. Sem uso de credenciais, login real, logout real ou navegador nesta etapa.

## Causa e limites

`createApp()` mantém as sessões em um Map por processo. Reiniciar o servidor perde a associação do cookie `ORBIT_SID` com o cliente autenticado. O cookie dura 24 h; não há um logout por poucos minutos de inatividade. A limpeza por inatividade ocorre somente acima de 64 sessões e para registros sem uso há mais de 24 h. Os reinícios executados na investigação anterior são suficientes para encerrar sessões; o relato atual não contém horário para atribuir cada ocorrência a um reinício específico.

O frontend mantinha `session.connected=true` após APIs recusarem acesso com 401. A atualização da ponte cloud também ignorava `/api/session` com `connected:false`. Somente o bootstrap após reload mostrava a entrada. O callback antigo foi executado em teste isolado e reproduziu esse estado inconsistente.

A auditoria de TV anterior utilizou cookies locais próprios. Seu encerramento também chama logout remoto OTT; o alcance desse RPC sobre outros logins no provedor não foi estabelecido. Não afirmar isolamento remoto somente porque os cookies locais são diferentes.

## Correção

- `web/login/session-guard.js` envolve o transporte JSON da aplicação. Sessão local ausente confirmada encerra o estado da interface; 401 ambíguo primeiro verifica `/api/session`. Rede, 503, 403 isolado e `connected:false` acompanhado de erro não provam logout.
- Verificações em foco, retorno da página, visibilidade e reconexão são agrupadas e limitadas a uma por 5 s por geração. Têm prazo de 5 s, sem polling periódico. Respostas antigas não invalidam um login novo. Troca confirmada de `libraryId` também exige nova entrada nessa aba.
- `web/app.js` salva o progresso na conta anterior, encerra o player, invalida tarefas e mostra a entrada com mensagem. Favoritos/histórico persistidos não são apagados. A guarda não chama `/api/logout`; STOP antigo não pode alcançar a geração seguinte.
- Erros de autorização da engine HLS acionam a mesma confirmação. O backend passou a identificar sessão local ausente com `SESSION_REQUIRED`, sem mudar TTL ou persistência. O frontend também suporta o 401 antigo, sem código.

## Verificação e ativação

55 testes focados passaram: 52 de autenticação, backend, guarda, HLS e ponte cloud; três adicionais executam as funções reais do app em contexto simulado para conferir ordem de limpeza e impedir que STOP/resposta antigos afetem novo login. Testes de backend usaram provedores sintéticos em portas locais. Sintaxe e `git diff --check` passaram.

O servidor real não foi reiniciado nesta etapa. Os arquivos de frontend são servidos do disco com `no-cache` e ficam disponíveis ao recarregar. O código adicional de erro do backend entrará no próximo reinício normal; sua ausência na instância atual é coberta pela confirmação compatível do frontend. Reprodução audiovisual e UI real não foram certificadas por estes testes.

Sessões continuam em memória: sobreviver ao reinício exige um projeto separado de persistência segura. Esta correção elimina o estado falsamente conectado, sem guardar senhas para reconectar automaticamente.

Atualização de ativação em 17/10, conferida às 13:00 BRT: o coordenador reiniciou o backend local após autorização explícita do usuário. `/api/session` anônima retornou `connected:false` e `SESSION_REQUIRED`; `/api/tv/home` anônima retornou 401 com o mesmo código. Essas respostas confirmam a versão atualizada do backend. O controle remoto falhou antes de acessar o Safari, portanto a nova entrada e a transição visual não foram certificadas nesta etapa.
