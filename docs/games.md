# Agenda de jogos

`lib/wplay-games.mjs` consulta o serviço informado pelo próprio acesso WPLAY. `web/daily-games.js` compartilha uma agenda entre Início e TV ao vivo. Não abre outra transmissão para consultar os jogos; o botão Assistir usa somente um ID de canal presente no catálogo visível da sessão.

## Evidência do contrato

A análise estática do APK 11.9.0d identificou `ServiceApi.getDateGameList` com URL dinâmica e os parâmetros `date`, `timezone` e `lang`. O chamador `ue.b.invokeSuspend` (code item `0x22a084`) acrescenta `/games` ao `service.football_url` recebido na autenticação. `MatchAllListViewModel.generate31DaysList` (`0x1a2054`) formata o fuso como deslocamento `±HH:MM`; a API local recebe um fuso IANA e calcula esse deslocamento para o dia escolhido.

O contrato estático é `BaseResponse<List<GameData>>`. São normalizados `id`, `name`, `league`, `date`, `status`, `score`, `teams` e `channels`. A ordem de `teams` é preservada; a análise não demonstra qual time é mandante. Os códigos de negócio de sucesso aceitos são `200`, `0` (compatibilidade dos contratos/testes anteriores) e ausência de código. Um erro explícito, como `{code:403,data:[]}`, gera `WPLAY_GAMES_REJECTED`; não se transforma em uma agenda vazia. Nenhuma URL de reprodução ou credencial faz parte da resposta pública.

Uma consulta autenticada pelo ambiente do APK, realizada durante a revisão de 15/10/2026, recebeu HTTP 200 e envelope `{code:200,data:[...]}` com 42 partidas para `2026-10-15` e `timezone=-03:00`. Os registros incluíam `date:'2026-10-15 13:40'`, status textuais numéricos e listas de canais vazias. Essa evidência confirma a resposta daquela consulta; não comprova o fluxo completo da interface web, disponibilidade futura, significado de cada status ou reprodução de uma partida. Nenhuma credencial foi copiada para os fixtures.

Um comparativo da mesma partida (`8620559`) recebeu `date:'2026-10-15 13:40'` tanto com consulta UTC como com `timezone=-03:00`. A quantidade da janela diária mudou (51 e 42 partidas), mas o horário dessa partida permaneceu igual. Portanto, o parâmetro controla a janela do dia e **não converte esse campo para o fuso pedido**. A hipótese inicial de aplicar `-03:00` ao campo foi corrigida.

O adaptador `wplayGames()` fornece explicitamente o contrato UTC a `normalizeWplayGames(payload, {timeZoneOffset:'+00:00'})`: `13:40` é `13:40Z`, convertido pelo frontend para o fuso do usuário. O normalizador isolado só interpreta `YYYY-MM-DD HH:mm[:ss]` quando recebe esse contexto; sem ele, uma data sem fuso continua com `start:null`. Datas impossíveis e offsets inválidos são rejeitados; timestamps com offset explícito ou Unix preservam seu instante original. O offset da consulta diária continua calculado pela data escolhida, incluindo fusos sazonais ou fracionários.

Os testes usam respostas sintéticas que reproduzem essa estrutura sem dados privados, além de ausência do serviço, erro de negócio, erro de rede, fuso sazonal e canais não encontrados. O fluxo web ainda depende do backend atualizado em execução e da sessão autenticada correspondente.

## Contrato local e estados

`GET /api/games?date=YYYY-MM-DD&timezone=America%2FMaceio&lang=pt` requer sessão autenticada. A resposta contém `available`, `date`, `timeZone` e `games`. Quando o provedor não anuncia o serviço, responde `available:false` e a interface mostra “Agenda não disponibilizada pelo serviço”. Um dia válido sem partidas mostra “Nenhum jogo informado para hoje”.

O backend atualizado anuncia `session.capabilities.games`. Sem essa capacidade, a interface informa que é necessário atualizar/reiniciar o servidor e não envia consultas nem cria um ciclo de tentativas. HTTP 404 recebe a mesma orientação. HTTP 401 pede novo login e para a atualização até uma nova sessão. Falhas temporárias do serviço mantêm uma mensagem segura, botão de tentativa e nova consulta após 30 segundos; URLs e mensagens cruas do provedor nunca são mostradas.

O cache dura 60 segundos. Sair da tela cancela timers e a consulta pendente; sair da conta limpa também os dados. Callbacks antigos não podem publicar resultados ou erros depois do cancelamento. A mesma seção preserva seus cards e foco durante atualizações do catálogo.

## Logos de times e competições

O próprio payload WPLAY informa `teams[].logo` e `league.logo`. Uma consulta autenticada de 15/10/2026 confirmou imagens PNG absolutas em `cdn.footystats.org`; os IDs e a ordem dos times vêm do mesmo registro da partida. Não há busca aproximada por nome nem substituição por outro clube de nome parecido.

`lib/sports-logo-cache.mjs` baixa essas imagens em uma fila compartilhada de até quatro conexões. Os arquivos ficam em `.local/sports-logos`, fora do Git: os bytes são deduplicados pelo conteúdo e o índice contém somente hashes, formato e data. Endereços do provedor, parâmetros de autenticação e cabeçalhos não são gravados. O cache existente continua legível após reiniciar o Node e é revalidado depois de sete dias quando a imagem reaparece na agenda.

A agenda retorna `/api/sports-image/<sha256>` sem esperar todos os downloads. Essa rota exige sessão WPLAY autenticada e pode aguardar o download em andamento; depois serve os bytes locais. As referências podem ser preservadas no cache global do Supabase, sem depender dos mapas temporários de `/api/image`. Uma falha conserva os nomes reais dos times e da competição, sem inventar imagem. Rasters PNG/JPEG/GIF/WebP/AVIF precisam de MIME compatível com seus bytes, tamanho máximo de 512 KiB e requisição com timeout. O transporte existente valida destinos e redirecionamentos contra acesso indevido à rede local. SVG/HTML e respostas inválidas não são persistidos.

Alterações em `lib/` exigem reiniciar o Node; atualizar somente a página não ativa uma rota nova. O servidor atual guarda as sessões em memória e seu reinício pode exigir novo login.

## Verificação

Execute `node --test tests/daily-games.test.mjs tests/wplay-games.test.mjs tests/sports-logo-cache.test.mjs tests/app-server-games.test.mjs`. O último teste inicia um servidor sintético local. Os testes de logos cobrem persistência após reinício, deduplicação, concorrência, limites, formatos e ausência de credenciais nos arquivos. A verificação da conta real não deve abrir canais, extrair credenciais ou reiniciar uma reprodução em andamento.
