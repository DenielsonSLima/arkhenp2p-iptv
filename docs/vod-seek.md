# Avanço e retomada de filmes e séries

`web/vod-seek.js` concentra o avanço da barra, as setas, a retomada e o salto de
abertura/créditos. Antes, a interface atribuía `video.currentTime` diretamente,
sem esperar os metadados nem verificar se a reprodução continuava depois do salto.

O relato de que sair e reabrir permite continuar no mesmo ponto é compatível com
uma leitura de mídia paralisada após o seek. Essa causa específica não foi
reproduzida: a validação foi feita por código e testes locais, sem abrir navegador
ou acessar uma conta do serviço.

## Contrato

```js
const seeks = new VodSeekController({video, onRecover, onStateChange});
seeks.attach({kind: 'movie', sourceKey: 'movie:123', recoveryAttempt: 0});
seeks.request(1200, {play: true, reason: 'user'});
seeks.reset();
```

`attach` aceita `movie` e `series`. `reset` remove timers e listeners; trocar de
fonte ou sair do player deve sempre chamá-lo. `request` retorna se a solicitação
foi aceita e espera pelos metadados quando necessário. O alvo fica dentro da
duração e dos intervalos `seekable` anunciados pelo navegador. O controlador
preserva a intenção de assistir ou permanecer pausado.

`seekable` representa os intervalos que o navegador permite buscar, não o vídeo
já carregado em `buffered`. Se uma origem anunciar somente parte do arquivo como
buscável, o alvo é limitado a essa parte e o estado inclui
`detail: 'seek-range-limited'`; a interface pode avisar o usuário. Não se deve
apresentar o ponto originalmente solicitado como alcançado nesses casos.

Um evento `seeked` sozinho não comprova que a reprodução voltou. Para vídeo em
execução, o controlador confirma avanço real de `currentTime`. Se isso não
acontecer em oito segundos, `onRecover` recebe
`{target, play, sourceKey, recoveryAttempt: 1}`. O carregador existente deve
reabrir a **mesma mídia**, reutilizando o elemento de vídeo e o grafo de áudio,
e passar `recoveryAttempt: 1` ao novo `attach`. A retomada usa `reason: 'recovery'`
ou `'resume'`; uma segunda falha encerra a recuperação automática. Uma nova
ação explícita (`user`, `opening`, `credits`, `restart`) permite uma nova tentativa
limitada. Erros de mídia, ausência de metadados e bloqueio de autoplay não
disparam recargas sucessivas.

`onStateChange` informa `waiting-metadata`, `seeking`, `ready`, `recovering`,
`failed` ou `paused`. A interface pode manter o indicador de carregamento durante
o seek e limpar esse indicador quando a reprodução voltar ou exigir intervenção.

## Transporte HTTP

A revisão encontrou encaminhamento de `Range` e preservação de `Content-Range`,
`Content-Length` e `Accept-Ranges` no proxy. A mesma mídia não aborta as outras
transferências por `beginPlayback`. O retry VOD existente repete somente falhas
transitórias **antes** de entregar uma resposta, preservando a faixa pedida.
Não foi encontrada evidência suficiente para alterar esse transporte ou repetir
um corpo parcialmente enviado.

## Verificação

`node --test tests/vod-seek.test.mjs` cobre metadados tardios, intervalos de seek,
intenção de pausa, avanço real, congelamento, recuperação limitada, cancelamento,
erros, autoplay bloqueado e encaminhamento do controle imersivo. Som, decodificação
e comportamento de um dispositivo Safari real continuam dependendo de conferência
manual do usuário.
