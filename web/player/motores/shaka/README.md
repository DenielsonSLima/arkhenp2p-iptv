# Adaptador Shaka

Implementação local de 16/10/2026 para Shaka **5.2.13**. Recebe a biblioteca já disponibilizada localmente; não instala pacote ou busca CDN. A aplicação escolhe o motor. Esta pasta não altera preferências, visual, conta, catálogo, fonte ou sessão do provedor.

```js
const ShakaHls = createShakaHlsClass({shaka, HlsClass: Hls});
const engine = new ShakaHls(config);
engine.loadSource(localPlaybackURL);
engine.attachMedia(realVideoElement);
// Ao encerrar, a aplicação aguarda a barreira antes da próxima abertura.
engine.destroy();
await engine.whenStopped;
```

`index.js` concentra ciclo de vida e eventos; `configuracao.js` traduz opções com correspondência pública; `faixas.js` apresenta faixas reais; `erros.js` filtra rotas e sanitiza erros; `erros-nativos.js` lê uma vez o diagnóstico de uma reprodução `src=` interrompida.

O adaptador reutiliza os enums do HLS.js real para os consumidores existentes. Expõe níveis, seleção manual/automática, áudio, legendas e estimativa de banda do Shaka após observar resposta real de segmento. Isso continua sendo estimativa do motor, não teste de velocidade. Resoluções e bitrate de níveis são declarações das faixas; a dimensão recebida continua no elemento de vídeo. Não emite fragmentos fictícios: `supportsFragmentMetrics=false`. `latency` usa `getStats().liveLatency`, em segundos no Shaka 5.2.13, quando disponível; `liveSyncPosition=null`, pois a borda buscável não equivale ao alvo de sincronização HLS.js.

Legendas usam a API pública Shaka 5 `selectTextTrack(faixa)` e `selectTextTrack(null)`. A opção escolhida fica guardada enquanto a exibição está desativada; habilitar seleciona a faixa. A leitura atual de `getTextTracks()` evita repetir seleção ao receber eventos, sem recorrer a métodos privados de visibilidade.

`loadSource` aceita somente rotas autenticadas da mesma origem em `/api/play/live|movie|series` e `/api/asset/...` ou `/api/asset?ref=...`. HLS informa o MIME conhecido; arquivos VOD deixam o Shaka identificar o formato, podendo usar seu modo nativo. Filtros de rede bloqueiam manifesto/segmento/chave externos. Não há configuração de licença DRM ou nova fonte.

`stopLoad()` invalida imediatamente a geração e inicia **destroy assíncrono**. `whenStopped` preserva falhas de encerramento para a aplicação, com rejeição já observada para evitar promessa solta. A próxima instância Shaka aguarda também a barreira da fábrica e do elemento. `supportsBufferedDrain=false`: o encerramento não conserva o buffer antigo em movimento. O provedor continua exigindo STOP na aplicação; destruir Shaka não substitui esse contrato.

O caminho nativo `src=` pode emitir `VIDEO_ERROR` sem expor o status HTTP pelos filtros de rede do Shaka. O adaptador remove a fonte imediatamente para conter novas sondagens do navegador e consulta apenas `/api/playback/status`, com o mesmo domínio/ID/attempt, credenciais da mesma origem e prazo de 1,5 s. A consulta é cancelada no STOP; resposta tardia não atinge outra abertura. Um 429 observado no backend volta ao controlador como 429 e `Retry-After`, preservando a pausa em vez de tratá-lo como erro de codec. Não há nova chamada de mídia nessa consulta. O encerramento também limpa `src` antes e depois de `destroy()` resolver; a barreira impede o próximo proprietário de iniciar durante essa limpeza.

Shaka não fornece o parse-only de `autoStartLoad:false`: a carga começa quando URL e vídeo estão associados, e `MANIFEST_PARSED` é emitido somente após `load()` e leitura das faixas reais. A aplicação precisa concluir STOP antes disso. Os retries internos ficam limitados a uma requisição, recuperação automática de MediaSource e prefetch de próximo conteúdo ficam desativados; recuperação pertence ao controlador compartilhado. Buffer em segundos é traduzido; limites em bytes, contagem HLS de margem e ferramentas HLS privadas não são equivalências prometidas.

Correção de erros nativos/encerramento em 16/10/2026: sete testes sintéticos em `tests/shaka-native-lifecycle.test.mjs` passaram, incluindo deduplicação de 100 eventos, retorno tardio após STOP, diagnóstico indisponível/inválido, ausência de consulta de mídia e destruição assíncrona antes do próximo proprietário. Sem navegador ou reprodução real; compatibilidade por dispositivo permanece pendente.

Fontes oficiais consultadas: [Player e ciclo assíncrono](https://shaka-project.github.io/shaka-player/docs/api/shaka.Player.html), [NetworkingEngine](https://shaka-project.github.io/shaka-player/docs/api/shaka.net.NetworkingEngine.html), [faixas, estatísticas e configuração](https://shaka-project.github.io/shaka-player/docs/api/shaka.extern.html), [erros e BAD_HTTP_STATUS](https://shaka-project.github.io/shaka-player/docs/api/shaka.util.Error.html).
