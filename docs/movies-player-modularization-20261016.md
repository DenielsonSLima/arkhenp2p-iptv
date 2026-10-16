# Reprodução de Filmes

Data: 2026-10-16. Estado: implementação local com integração pelo responsável principal. Evidência desta extração: leitura do código e checagens estáticas; sem testes, navegador, reprodução ou infraestrutura. O documento não certifica funcionamento audiovisual.

## Limites e responsabilidades

Os módulos de `web/filmes/` recebem o vídeo, HLS, `AudioProcessing`, `ChannelVolumeMemory`, `VodSeekController`, `PlaybackPositionGuard`, `ResumePrompt` e `PlayerTools` já existentes. Não criam outra instância desses recursos, não abrem conexão com provedor/Supabase e não consultam TV/EPG. O orquestrador principal mantém uma reprodução ativa, autorização, intent/serial, pausa por 429, destruição HLS, remoção de `src` e `/api/stop`.

| Arquivo | Responsabilidade real extraída |
| --- | --- |
| `audio.js` | Escolha de faixas HLS/nativas e transição de fonte pelo processamento compartilhado. Filme remove a associação de volume por canal e conserva a preferência de áudio/mute atual. |
| `legenda.js` | Escolha/desativação de legendas HLS, embutidas e locais. Arquivo local limitado a 2 MB, convertido pela função compartilhada existente; blobs entram em `tools.localTracks`, cuja limpeza continua em `PlayerTools.reset`. Retorno de outro filme é descartado. |
| `resolucao.js` | Automática/manual somente nos níveis realmente oferecidos pelo manifesto. Arquivo nativo ou variante única informa Original e dimensões medidas; nome do filme não cria variantes nem prova 4K. Não troca de título ou de canal. |
| `buffer.js` | Perfis Equilibrada e Mais estável, limites de manifesto/fragmentos e aplicação sem salto de posição. Fontes nativas mantêm buffer automático. A preferência `profiles.vod` existente continua sendo usada; não é criado outro armazenamento. |
| `reproducao.js` | Retomada por conta/filme, listener de metadados, continuação após fallback, guarda da única recuperação de seek e leitura de progresso. Não persiste histórico nem decide sugestões/autoplay. |

## Integração mínima em PlayerTools

Importar os helpers dos quatro arquivos de recursos e delegar somente quando `this.current?.item.kind==='movie'`:

| Método existente | Delegação |
| --- | --- |
| `renderAudio()` | `return renderMovieAudio(this)` |
| `disableSubtitles()` | `return disableMovieSubtitles(this)` |
| `renderSubtitles()` | `return renderMovieSubtitles(this)` |
| `addSubtitle(input)` | `return addMovieSubtitle(this,input,{toVtt:subtitleToVtt})` antes de limpar/ler `input.files` no ramo compartilhado |
| `renderQuality()` | `return renderMovieQuality(this)` |
| `applyAutoQuality()` | `return applyMovieQuality(this)` |
| `getQualitySelection()` | `return movieQualitySelection(this)` |
| `renderBuffer()` | `return renderMovieBuffer(this)` |

`configFor('movie')` devolve `moviePlayerConfig(this.profiles.vod)`. As funções exportadas `fastLoadPolicies('movie')` e `bufferConfig(profile,'movie')`, se usadas, podem delegar a `movieLoadPolicies()` e `movieBufferConfig(profile)`. `autoStartLoad:true` conserva o início HLS VOD normal; Filme não usa a política de início de TV.

No método `setProfile`, manter validação, preferência `vod` e persistência existentes. Para a instância atualmente reproduzindo filme, aplicar `applyMovieBuffer(this,key)`; os demais ramos permanecem com sua política atual. O helper não persiste preferências nem chama seek/startLoad.

## Integração no orquestrador principal

Criar uma vez, com as dependências já inicializadas:

```js
const movieAudio=new MovieAudio({volumeMemory:channelVolumeMemory,audioProcessing});
const moviePlayback=new MoviePlayback({
  video,vodSeek,positionGuard,resumePrompt,
  getScope:()=>({account:session?.account?.libraryId,epoch:connectionGeneration}),
  serializeItem:snapshot,canRemember:mayRemember,
});
```

No começo da abertura de filme, onde o áudio já é preparado durante a ação do usuário:

```js
movieAudio.begin(item,playerURL(item,null,player.attempt),{
  isCurrent:()=>serial===playbackSerial&&accountGeneration===connectionGeneration,
});
```

No ramo de filme que substitui as chamadas compartilhadas de `positionGuard.attach`, `vodSeek.attach`, `resumePrompt.attach` e o listener `loadedmetadata`:

```js
const attachment=moviePlayback.attach({
  item,historyEntry:historyFor(item),accountLibraryId:session?.account?.libraryId,
  playOptions,sourceKey:playbackSourceKey(item,null),
  isCurrent:()=>serial===playbackSerial&&accountGeneration===connectionGeneration&&player?.item===item,
  onReady:()=>{player.mediaReady=true;playerMetadataCleanup=null;},
  playNow,
});
playerMetadataCleanup=attachment?.cleanup||null;
```

O retorno é `{resumeTime,sourceKey,cleanup}` ou `null` quando filme/conta não são elegíveis. `cleanup` remove somente o listener daquele attach, mesmo se um attach novo já estiver ativo. No evento de metadados, `onReady` ocorre antes do seek/play e o ticket é revalidado após o callback. `playNow` só é chamado se `resumePlay!==false`.

No `playing`, o ramo de filme chama `movieAudio.playing()`. Na parada de filme, chamar `movieAudio.reset()` no lugar do reset de áudio daquele ramo. `moviePlayback.reset()` remove apenas o listener e o ticket próprio; não reinicia os controladores compartilhados, que o fluxo central já limpa uma vez. Salvar o checkpoint final antes de descartar esse ticket. Desanexar mídia nativa conserva `player.detachedContinuation` antes de remover `src`; esse estado em RAM continua tendo precedência sobre qualquer leitura posterior do vídeo vazio.

## Continuação, recuperação e progresso

`moviePlayback.continuation({seekTarget:player.seekTarget})` preserva o alvo pendente, posição atual, pausa e tentativa de seek. O ramo de Séries continua usando sua política compartilhada.

`moviePlayback.recoveryOptions(context,{quality:playerTools.getQualitySelection(),retryAfterUntil:player.retryAfterUntil,failed:playerTools.current?.failed,status,code})` retorna opções para o mesmo filme ou `null`. Exige conta/ticket/fonte atuais, alvo válido e `recoveryAttempt===1`; não agenda recuperação em 429, autenticação, conta/PIN/sessão, STOP ou falha terminal. O chamador continua dono de `openPlayer`; uma tentativa não prova reprodução. Não transformar `null` em nova tentativa ou abrir outra fonte automaticamente.

`moviePlayback.progress({force,completed,mediaReady:player.mediaReady,lastSavedAt:progressLastSaved})` é uma extração opcional do ramo de checkpoint de filme. Retorna entrada sanitizada por conta ou `null`, mantendo o intervalo de 5 s, mínimo de 3 s fora de gravação forçada, classificação adulta e guarda de retomada. O principal continua responsável por atualizar `progressLastSaved`, histórico, persistência, biblioteca cloud e estado concluído do player. As sugestões de fim continuam exigindo `video.ended` real e não iniciam outro filme automaticamente.

Fontes da extração: `web/app.js` (abertura/parada/checkpoint), `web/player-tools.js` (menus/configuração), `web/audio-processing.js`, `web/channel-volume-memory.js`, `web/playback-position.js`, `web/vod-seek.js`, `web/immersive-player.js` e o contrato de domínio em `docs/memory/movies.md`. As políticas de TV em `web/tv/` foram consultadas para preservar a separação, sem serem importadas pelos novos módulos de Filmes.
