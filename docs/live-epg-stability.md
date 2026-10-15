# Estabilidade da programação ao vivo

Em 15/10/2026, a investigação encontrou dois caminhos que apagavam uma programação ainda válida: reiniciar o player criava um `LiveProgramFeed` com lista vazia; uma resposta HTTP200 vazia substituía a lista do canal, dos vizinhos e dos cards. Falhas HTTP já preservavam a lista, mas esses dois caminhos não tinham a mesma proteção.

`LiveProgramFeed` agora mantém até64 guias por conexão, com validade curta de60 segundos. Uma programação que continua vigente pode preencher imediatamente o player durante uma nova consulta; ela deixa de ser atual quando o horário termina. O cache é separado por `getNamespace`, e a mudança de conexão interrompe consultas e descarta o conteúdo anterior. Respostas antigas não atualizam a nova seleção.

`LiveProgramFeed.peek(id)` e `ChannelGuide.peek(id)` retornam `{list}` utilizável ou `null`. O fluxo de abertura captura esse valor antes de parar a reprodução anterior, passa `initialProgram` ao player e usa `start(id,{initialData})` no feed. Isso preserva o primeiro quadro de programação ao entrar pelo card ou recuperar o mesmo canal. Os feeds vizinhos também reutilizam seu cache antes da primeira emissão e interrompem polling da conexão anterior.

`retainCurrentProgramList` conserva a lista anterior somente quando ela contém programa vigente e a nova resposta não contém nenhum programa com horários válidos. Uma resposta válida substitui a anterior; relógio, canal e conexão continuam determinando a apresentação. Nenhuma programação é inventada ou associada por semelhança de nome.

O backend WPLAY mantém o vínculo explícito `epgSameAs`, depois `chid`/ID nativo, e o índice por sessão. Essa revisão não alterou o transporte da mídia nem o mapeamento do provedor.

Validação: `node --test tests/program-guide.test.mjs tests/neighbor-program-feeds.test.mjs tests/wplay-epg.test.mjs` passou em28 testes, incluindo retry sem quadro vazio, HTTP200 vazio, troca de conta com resposta tardia, cache de vizinhos e expiração pelo relógio. São testes internos controlados; não comprovam disponibilidade da transmissão Megapix no provedor.
