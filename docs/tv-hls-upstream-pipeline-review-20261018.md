# TV: revisão estática do pipeline HLS.js

Data: 18/10/2026. Estado: pesquisa pública e inspeção estática; proposta pontual ainda não aplicada. Nenhuma alteração de player, versão, infraestrutura ou deploy nesta revisão. Sem conta, login, navegador, mídia ou execução de APK. Os testes sintéticos anteriores e o relato posterior de abertura local rápida não certificam reprodução atual na Vercel ou no Safari.

## Resultado principal

Existe um defeito confirmado upstream na versão vendorizada, HLS.js1.6.13: ao carregar diretamente uma Media Playlist live, a primeira atualização pode ficar agendada com um intervalo extra. A [issue7556](https://github.com/video-dev/hls.js/issues/7556) reproduz o caso com um segmento; a [PR7875](https://github.com/video-dev/hls.js/pull/7875) corrige o agendamento duplicado. Isso é um candidato concreto para atraso/stall inicial no caminho HLS.js, sem demonstrar que foi a causa das capturas. Safari nativo não passa por esses controllers.

O defeito não fabrica uma playlist estagnada: se novos pedidos já concluídos continuam recebendo o mesmo conteúdo, remover o atraso inicial não cria os segmentos ausentes. A observação coordenada de uma janela pequena sem avanço por cerca de23s, apesar de pedidos concluídos, exige separar instante de cada pedido, duração de transferência e avanço real da cauda. Não autoriza atribuir causa ao provedor ou ao decoder.

## Caminho real da aplicação

`web/app.js` obtém descritores durante a barreira STOP e só anexa a nova mídia depois de ambos concluírem. O transporte escolhe HLS nativo em Safari/iOS compatível; nos demais caminhos suportados, cria HLS.js. Para TV, `web/tv/buffer.js` configura `autoStartLoad:false`, `initialLiveManifestSize:1`, prefetch inicial e margem de quatro segmentos no perfil equilibrado. `prepareTVHlsStartup` escolhe o nível compatível e chama `startLoad()` no evento `MANIFEST_PARSED`. Logo, a opção de autostart desativado não significa ausência de início explícito nesse evento.

O observer de prontidão é posterior ao transporte: exige estado utilizável, dimensões e evento válido ou avanço do relógio sem seek. Ele não cria requests, não altera a URI, não faz seek e não recupera dados faltantes. `playing`, relógio e dimensões continuam distintos de uma prova de apresentação contínua de quadros.

Fontes locais: `web/live-playback-session.js`, `web/app.js`, `web/player-tools.js`, `web/tv/buffer.js`, `web/tv/canais/resolucoes.js` e `web/tv/player/estado-media.js`.

## PlaylistLoader, controllers e erro

O pedido inicial é contexto MANIFEST e usa `manifestLoadPolicy`. Se seu conteúdo já for Media Playlist, o parser cria um único nível com os mesmos detalhes e emite `MANIFEST_LOADED`; o fluxo segue até `MANIFEST_PARSED` e `LEVEL_LOADED`. Recarregamentos LEVEL usam `playlistLoadPolicy`, mas o PlaylistLoader passa `timeoutRetry:null` e `errorRetry:null` ao loader delegado. Isso evita que dois mecanismos independentes façam retry do mesmo pedido. Falhas de nível são inicialmente não fatais. [Fonte1.6.13: PlaylistLoader](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/loader/playlist-loader.ts).

O ErrorController lê a política original, conta erros de playlist e escolhe retry ou alternativa. BasePlaylistController recebe a decisão, agenda o atraso e marca a ação resolvida; sem recuperação ou alternativa aplicável, a etapa final do ErrorController pode escalar a falha e parar os carregamentos. A aplicação só então aplica sua recuperação limitada do mesmo owner. Portanto, um ensaio direto de XHR prova deadlines/abort desse loader, mas não toda essa cadeia. [ErrorController1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/controller/error-controller.ts), [BasePlaylistController1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/controller/base-playlist-controller.ts).

Uma playlist parseável que repete os mesmos segmentos não equivale a timeout HTTP. O cálculo de reload usa metade da duração alvo quando a captura não mudou. Uma atualização válida percorre `LEVEL_UPDATED`, que reinicia o contador de erro de playlist. A versão1.6.13 não contém a opção posterior `liveMaxUnchangedPlaylistRefresh`; aumentar o prazo de HTTP não detecta ausência de avanço. [Cálculo do intervalo1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/utils/level-helper.ts), [StreamController1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/controller/stream-controller.ts). A opção de detectar repetições é apresentada como adição posterior nas [notas1.7.0](https://github.com/video-dev/hls.js/releases/tag/v1.7.0); não foi ativada nem transplantada nesta rodada.

## Defeito7556 e proposta restrita

No carregamento direto, PlaylistLoader calcula uma agenda futura a partir do início do pedido mais o intervalo de reload. BasePlaylistController volta a somar o intervalo mesmo quando essa agenda ainda está no futuro. Com transferência rápida e um segmento, isso pode resultar em primeiro reload próximo de duas durações alvo, deixando o buffer inicial acabar antes da atualização. O código vendorizado contém a soma incondicional; a inspeção não depende apenas do título da issue.

A correção upstream faz a soma somente quando a agenda anterior já chegou ao instante atual. A [mudançaaa2c4ad](https://github.com/video-dev/hls.js/commit/aa2c4ad) altera a guarda do ramo para `else if (details.requestScheduled <= now)`. A [release1.6.17](https://github.com/video-dev/hls.js/releases/tag/v1.6.17) registra esse backport. Nenhuma versão foi substituída agora.

Proposta para uma etapa futura autorizada: aplicar somente essa guarda com origem/build rastreáveis e testar o pipeline Hls/PlaylistLoader/LevelController/ErrorController, não apenas o delegate XHR. O teste deve exercitar nossa abertura com autostart desativado e início explícito em `MANIFEST_PARSED`, primeiro manifesto direto e master separado, um e vários segmentos, tempo de resposta consumindo parte do intervalo, resposta inalterada, erro/retry, troca de owner e destroy. Medir a agenda efetiva dos pedidos com relógio virtual sem abrir mídia real; depois, uma verificação audiovisual separada continua necessária.

O workaround sugerido na discussão, `initialLiveManifestSize:3`, evita começar com poucos segmentos, mas pode prolongar a espera quando a própria janela demora a crescer. Não foi adotado como correção geral, nem proposto novo aumento de timeout. A guarda pontual não muda qualidade, margem live, URI autorizada, sid/gen, STOP, tags ou bytes dos segmentos.

## Candidato secundário condicionado a timestamps

A versão vendorizada também contém a condição antiga de `computeInitPts` discutida na [PR7752](https://github.com/video-dev/hls.js/pull/7752). Ela pode tratar timestamp legítimo próximo de zero como rollover, gerando offset incorreto e repetição de segmento em determinados streams. A fonte [MP4Remuxer1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/src/remux/mp4-remuxer.ts) e os bytes locais conservam essa condição. Não há nesta revisão prova dos PTS/DTS da mídia do incidente, nem loop desse remuxer observado. Logo, é um candidato delimitado, sem alteração proposta agora. Também não explica por si uma playlist upstream que não cresce.

## Comparação com APK e relato do aplicativo iOS

A [evidência estática existente do APK](engenharia-reversa-wplay-20261016/05-reproducao-e-memoria.md) identifica interfaces Media3/ExoPlayer e VideoView, transportes nativos e adaptadores protegidos. Os defaults empacotados de início/rebuffer são1s/2s, mas não demonstram os valores efetivamente usados nem incluem autenticação, descoberta, peers ou apresentação do primeiro quadro. Não foram executados APK, bibliotecas ou ponte local.

O usuário identificou o aplicativo iOS como correspondente ao serviço e houve observação de quadros no telefone. Isso é evidência de reprodução nesse aplicativo/dispositivo naquela observação. Sem artefato ou rastreamento do aplicativo iOS, não comprova que ele execute o código Android, Media3, HLS.js, os mesmos headers, fonte, instante ou protocolo. A comparação não justifica copiar um limiar do APK para JavaScript ou afirmar equivalência de engines.

## Limites e estado final

Os32testes focados anteriores confirmam seus cenários sintéticos; o conjunto integrado de147testes relatado na rodada também não certifica decodificação ou continuidade em dispositivo real. Esta revisão não executou novos testes, browser ou mídia. Corrigiu somente a delimitação da fixture e documentou a pesquisa; a aplicação do defeito7556 permanece proposta.

As fontes públicas são o repositório, releases e fórum técnico oficial HLS.js, com versões fixadas quando a conclusão depende de código. Não foram usados relatos de terceiros como prova da causa local. [Relatório anterior de latência](tv-playback-latency-20261018.md) conserva a mudança10/15s e as medições sanitizadas de fases, sem certificação audiovisual.
