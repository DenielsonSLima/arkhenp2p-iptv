# Player visual compartilhado

`orquestrador.js` é a entrada canônica consumida pelo aplicativo. A fachada antiga da raiz foi removida após migrar os consumidores. A sessão e a fonte continuam sob uma única composição em `../app.js`.

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.js` | Montagem da superfície, visibilidade, seek, tela cheia e integração dos componentes. |
| `dom.js` | Elementos, ícones e botões sem estado de reprodução. |
| `controles/reproducao.js` | Play/pause sobre o vídeo existente; listeners e limpeza próprios. |
| `controles/volume.js` | Slider/mute e apresentação; persistência injetada pelo callback da aplicação. |
| `teclado.js` | Despacho de teclado/controle remoto e proteção de campos, menus e ajustes. |
| `motores/` | [Escolha Atual/Shaka](motores/README.md), preferência por navegador e adaptador isolado do Shaka. |
| `troca-canal/` | [Barra, serviço e controlador da troca](troca-canal/README.md): descritores, intenção e visual por origem da ação. |
| `troca-canal/continuidade/` | [Dois elementos locais, preparação e áudio](troca-canal/continuidade/README.md), com uma fonte remota e promoção após prontidão real do alvo. |
| `../tv/player/grade.js` | Apresentação de anterior/selecionado/próximo e seus programas. |
| `../tv/player/navegacao.js` | Seleção temporária por ID, confirmação, troca direta e expiração. |
| `../tv/player/canais.js` | Validação dos canais numerados e vizinhos, sem DOM. |
| `../tv/player/programacao.js` | Inscrição no mapa EPG já compartilhado; não abre mídia. |

Serviços de TV continuam em `../tv/services.js`, políticas de buffer em `../tv/buffer.js` e áudio em `../tv/canais/audio.js`. Filmes conservam `../filmes/reproducao.js` e suas políticas; séries conservam os controladores de episódio, marcadores e seek. O frontend usa módulos JavaScript e controladores com ciclo de vida, sem criar hooks React artificiais.

Somente a confirmação lateral prepara o alvo silenciado em um segundo elemento local, após STOP remoto do anterior. O buffer antigo é finito; não há recebimento paralelo dos vizinhos. `reset()` cancela seleção, timers e inscrição da grade; `destroy()` também remove listeners dos controles. [Decisões da navegação](../../docs/tv-player-navigation-20261016.md) e [limites da continuidade](troca-canal/continuidade/README.md).
