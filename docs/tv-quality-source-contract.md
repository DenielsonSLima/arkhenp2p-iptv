# Qualidade e fontes de TV ao vivo

Atualizado em 15/10/2026. Esta alteração preserva o ID de catálogo do canal e a biblioteca da conta. Selecionar outra entrada de `sources[]` não cria outro canal nem migra favoritos ou histórico.

## Contrato do backend

`client.liveSources(id, {signal})` retorna:

```js
{
  channelId: '405',
  revision: 'hash de metadados da lista',
  selectedSourceId: 'n_...',
  sources: [{
    id: 'n_...',
    label: 'FHD',
    quality: 'FHD',
    available: true
  }]
}
```

`quality` só aparece para um rótulo reconhecido do serviço. `declaredWidth`, `declaredHeight`, `frameRate`, `videoCodec` e `bitrateBps` aparecem somente quando seus dados existem na fonte; `kbps`, quando fornecido, é convertido para bits por segundo. Um rótulo “4K” não fabrica largura ou altura. Campos `qc`, `qs` e `bType` não recebem interpretações inventadas.

Os IDs de fonte são determinísticos dentro do canal e não contêm endereços, cookies, tokens ou credenciais. A revisão identifica a lista atual. Fontes sem qualidade informada continuam visíveis. Entradas incompatíveis com o transporte da sessão são descritas com `available:false`; o backend não inicia outra engine para torná-las disponíveis.

`playbackURL(type, id, container, {sourceId, attempt, signal})` aceita a seleção. O servidor deve validar a sessão e o controle parental antes de listar ou reproduzir. O par canal/fonte pertence à intenção de abertura: HEAD, GET e polls da mesma intenção compartilham a preparação; uma troca precisa de outra intenção. A URL privada continua resolvida exclusivamente no backend a partir do catálogo autorizado.

Sem `sourceId`, a seleção automática começa na maior qualidade anunciada conhecida entre as fontes compatíveis. Empates e fontes de qualidade desconhecida conservam a ordem do provedor. HTTP e `address_backup` HTTP só são usados se entregues pelo serviço e aprovados pela fronteira de rede. A ponte TVCore recebe apenas a URI TVBus exata da fonte escolhida; `tvcars://` não é passado à TVCore.

O adaptador OTT enumera todas as variantes da mesma identidade autorizada, substituindo a preferência fixa por HD. Nomes iguais em identidades distintas continuam ambíguos. A parada confirmada por HTTP 204, a fila e o intervalo mínimo de três segundos entre gerações permanecem vigentes.

## Contrato do player

`PlayerTools.attach` aceita `sources`, `sourceId` e `onSourceChange`. O callback recebe o descritor e as opções `{sourceId, automatic, qualityMode, adaptiveState, reason}`. O chamador reabre o mesmo item com outra fonte e outra intenção de reprodução. `getQualitySelection()` inclui `sourceId`; `getSourceSelection()` retorna a seleção e a lista. O estado de recuperação viaja em `adaptiveState.liveSourceState` entre trocas automáticas do mesmo canal.

Em TV com HLS.js, `configFor` usa `autoStartLoad:false`. O listener de `MANIFEST_PARSED` escolhe um índice real de `hls.levels` e chama `startLoad()` uma vez. Em Automática, escolhe o maior nível anunciado com formato conhecido como compatível e conserva `loadLevel=-1` para ABR. Uma escolha manual válida não é substituída pela seleção inicial automática. Filmes e episódios conservam a configuração anterior.

O menu mantém as fontes anunciadas, inclusive as sem qualidade identificável, e os níveis do manifesto. Formatos comprovadamente incompatíveis permanecem visíveis, desabilitados. A resolução recebida é informada separadamente por `videoWidth` e `videoHeight`; nenhum nome de fonte é tratado como prova de pixels recebidos.

`trySourceFallback(reason, {status, code})` devolve se iniciou uma troca. O chamador pode usá-lo em falhas específicas da fonte antes de marcar a reprodução como encerrada. Não troca fontes automaticamente diante de autorização, controle parental, sessão encerrada, HTTP 409/429, parada não confirmada, erro estrutural da engine ou indisponibilidade de catálogo.

O orçamento por abertura permite no máximo duas trocas, sem revisitar uma fonte já tentada. A recuperação periódica considera duas interrupções em 30 segundos com menos de dois segundos de buffer. A inicialização lenta exige dez segundos após manifesto ou metadados disponíveis, sem reprodução e sem pausa; não usa o tempo de autenticação como medida de qualidade. Em manifestos com múltiplos níveis, ABR tem prioridade; a recuperação periódica externa espera o menor nível compatível. Fontes sem nível inferior podem usar uma alternativa equivalente, sempre dentro do orçamento.

## Evidência e limites

- O APK analisado já comprovou `getDefaultUrl()` devolvendo `sources[índice].address`; isso não demonstra seleção inicial da maior qualidade pelo aplicativo. Referências: `analysis/WPLAYP2P-11.9.0d-auth-contract.md` e `analysis/WPLAYP2P-11.9.0d-live-http-alternatives.md`.
- A [API HLS.js v1.6.13](https://github.com/video-dev/hls.js/blob/v1.6.13/docs/API.md#hlsstartlevel) define índices reais de início e controle automático. O comportamento de sondar o menor nível com `startLevel:-1` e `testBandwidth:true` consta da mesma documentação. A seleção nova não usa `Infinity`, comportamento problemático registrado na [issue oficial 6172](https://github.com/video-dev/hls.js/issues/6172).
- O [Media3](https://developer.android.com/media/media3/exoplayer/track-selection) distingue faixas oferecidas, suportadas e selecionadas. Sua [implementação adaptativa](https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/trackselection/AdaptiveTrackSelection.java) demonstra histerese e margem de banda; os parâmetros de recuperação acima são escolhas deste produto, sem atribuí-los ao WPLAY.
- O [HTML Standard](https://html.spec.whatwg.org/multipage/media.html#dom-video-videowidth) define as dimensões do vídeo e o evento `resize`. Essas métricas não certificam que o programa tenha sido produzido originalmente em 4K.

Verificação desta etapa: leitura do diff, `node --check` dos módulos alterados e bundle de `web/player-tools.js` com esbuild, destinado apenas a `/private/tmp/arkhen-quality-player-tools.js`. Não foram executados testes, navegador, APK, engine, canais ou alterações remotas. Qualidades efetivamente oferecidas pela conta, tempo de abertura, pixels e estabilidade prolongada ainda dependem da validação audiovisual do usuário.
