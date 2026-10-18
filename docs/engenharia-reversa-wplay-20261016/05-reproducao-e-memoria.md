# 05 — Reprodução, engines e memória

## Escopo e força da evidência

Alvo principal: `WPLAYP2P.apk`, versão `11.9.0d`/`1190`, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. Levantamento estático da sessão de 16/10/2026, sem carregar bibliotecas nativas, executar o APK, autenticar conta ou iniciar mídia.

A reprodução reúne uma interface Media3/ExoPlayer, outra interface `VideoView`, transporte TVCore/TVBus e uma ponte Go `Libtvcar`. O arquivo chamado `libijkplayer.so` é carregado pela proteção `NativeUtil`; o nome do arquivo não identifica, sozinho, um player IJK em uso. A escolha final de fonte/player passa por métodos nativos protegidos.

Convenções deste documento:

- **Direta:** metadados/bytes do APK atual ou método REA/JADX cujo envelope contém o SHA acima.
- **Histórica estática:** relatório anterior explicitamente vinculado ao mesmo SHA; o mapeamento de VM não foi refeito nesta sessão.
- **Inferência:** interpretação indicada como tal; não equivale a comportamento observado em execução.
- Os offsets DEX são relativos ao membro `.dex` descomprimido. `code_item` e início das instruções são endereços diferentes, separados por 16 bytes. Método `native` tem `code_item=0`; zero não é endereço de corpo JNI.
- `ELF VA` é endereço virtual relativo à imagem ELF, antes de ASLR; `arquivo` é offset dentro da `.so` descomprimida. Não são offsets no ZIP/APK nem endereços de um processo.

Os IDs completos, operações, classes e estados de corpo estão em [evidencias-reproducao.json](evidencias-reproducao.json). O inventário verificável de métodos/campos está em [metodos-primary.tsv](metodos-primary.tsv) e [campos-primary.tsv](campos-primary.tsv).

## Camadas de reprodução identificadas

| Camada | Evidência direta | O que ela comprova |
| --- | --- | --- |
| Tela principal | `Spark.H2:ExoPlayer`, `Spark.I2:PlayerView`, `Spark.x3:VideoView`, `Spark.U1:TVCore`, `Spark.J2:te.c` | O aplicativo contém referências às duas interfaces de player e à engine de transporte. Campos não provam qual ramo está ativo. |
| Adaptador comum | Interface `te.c`, 23 métodos abstratos: `prepare/start/stop/pause/release/seekTo`, duração/posição/buffer e `e(Uri,HashMap)` | Existe um contrato comum com URI e mapa de parâmetros. Sem corpo, o significado de cada entrada do mapa permanece aberto. |
| Adaptador Media3 | `te.d`, campos `a:ExoPlayer` e `b:PlayerView`; 23 de 24 métodos são `native` | A implementação está protegida. A enumeração Java não recupera suas decisões de buffer/codec/liberação. REA `ev_9379cc…`. |
| Adaptador de plataforma | `te.e`, campo `a:VideoView`; 25 de 26 métodos são `native` | Há um segundo adaptador com a mesma superfície. Não foi demonstrado um fallback automático entre adaptadores. REA `ev_88fc53…`. |
| View de plataforma | `SafeVideoView extends android.widget.VideoView`; `onLayout/onMeasure` nativos | Subclasse específica do aplicativo. Não é um `IjkVideoView` identificado. `class_def` em `classes2.dex:0x6ea88`. |
| Decoder FFmpeg | Classes `androidx.media3.decoder.ffmpeg`, loader `ffmpegJNI` e exports JNI correspondentes | Extensão de áudio FFmpeg empacotada e conectada à API Java Media3. Presença não prova que um stream específico use software decoding. |
| Transporte TVBus | `com.tvbus.engine.TVCore`, `TVService`, `libtvcore.so` | Superfície de autenticação, inicialização, preparação, start/stop e callbacks do transporte. |
| Transporte Go | `com.libtvcar.Libtvcar`, `go.Seq`, `libgojni.so` | Ponte Java/Go distinta da TVCore. As duas interfaces não são intercambiáveis por simples troca de esquema de URI. |
| Download VOD | `VodOfflineDownloadService extends DownloadService` Media3 | Há infraestrutura de download separado da reprodução. Agendamento efetivo e política de cache dependem de código protegido; ver também a análise de armazenamento do dossiê. |

No inventário direto dos **10.277 `class_defs`** dos dois DEX não há descritor no namespace `tv/danmaku/ijk/`. A inspeção exata de `tv.danmaku.ijk.media.player.IjkMediaPlayer` também retornou classe ausente. Essa conclusão é limitada a nomes/classes Java presentes no APK: não exclui código nativo sem símbolos ou incorporado de outra forma.

## Proteção nativa e FFmpeg

`com.nmmedit.protect.NativeUtil.<clinit>` chama `System.loadLibrary("ijkplayer")`. Evidência fresca REA `ev_86a92382aa68a2e7fffc49a083805eda6af70bc64a28c1510f337b400aefa2b8`, `classes.dex` `code_item=0x6dd890`. Seus métodos `classesInit0(int)` e `classes2Init0(int)` são nativos. Na tabela dinâmica do ELF ARM64 `libijkplayer.so`, o único símbolo definido é `JNI_OnLoad`, no offset de arquivo/VA `0x150948`, com 148 bytes. Isso é coerente com registro JNI dinâmico/proteção e impede usar ausência de exports `Java_*` como ausência de implementação.

A classe `TVCore` tem **50 métodos, 47 nativos**. Seu inicializador comum chama `NativeUtil.classesInit0(1)` e tenta carregar `tvcore`, tratando falha de carregamento; `getInstance()` mantém singleton/handle nativo. A superfície de métodos é confirmada pelo envelope REA `ev_aa933a3331d7b27993008211a507bd69ac3be0876a945289e99b425b56eefc20` vinculado ao alvo e pelo DEX atual (`class_def=0x152f94`; `<clinit>` `0x700f0c`; `getInstance` `0x700f60`). Não há corpo Java para os 47 métodos nativos.

`FfmpegLibrary.<clinit>` registra o módulo `media3.decoder.ffmpeg`, cria um `LibraryLoader("ffmpegJNI")` que chama `System.loadLibrary`, e inicializa `inputBufferPaddingSize=-1`. Evidência fresca `ev_8e6fb6bb3eb2d84f10fcb9aba535deb8db5dfeee9196ea60aaa7057e2fd580df`, `classes.dex:0x4998ec`. O carregamento/decoder disponível continua condicionado ao caminho que utilizar essa extensão; não foi recuperada uma garantia de que o aplicativo sempre a prefira.

## Inicialização e fronteira de servidor da TVCore

`TVService.TVServer.run()` foi recuperado integralmente nesta sessão: REA `ev_37dd39ac2912ac00e89a9340304ec741502219b01ed93b2ed9b672917014ca5d`, `classes.dex` `code_item=0x701028`, instruções `0x701038`.

```text
tvcore.setPlayPort(8902)
tvcore.setServPort(0)
tvcore.setRunningMode(1)
result = tvcore.init(applicationContext)
TVService.bInited = true
if result == 0:
    tvcore.run()
```

`RM_MASTER=1` consta nos campos estáticos da TVCore. O valor de porta zero é o argumento passado, sem atribuir a ele uma porta final presumida. `bInited=true` ocorre mesmo quando `init` devolve erro: esse booleano não pode ser interpretado como autenticação ou mídia pronta. O corpo mostrado não comprova em que thread o `Runnable` foi iniciado; os callbacks de criação do serviço estão protegidos.

O relatório estático anterior `analysis/WPLAYP2P-11.9.0d-native-bridge-review.md`, vinculado ao mesmo SHA, mapeou `Spark.X0()` no `libijkplayer.so` ARM64: wrapper `0xf3d68`, VM `0x8ab68` com 442 words. Ele descreve dependência de `AuthInfo.service`, Activity viva e aplicação em primeiro plano, seguida de:

| Aresta recuperada anteriormente | Origem declarada | Offset VM |
| --- | --- | --- |
| `TVCore.setAuthUrl` | `service.auth_url_sdk`, no ramo `h.z==3` | `0x8ac50` |
| `setUsername/setPassword` | Preferências da conta | `0x8aca6` / `0x8acf8` |
| `setOption("doh_url",…)` | Valor selecionado, somente se não nulo | `0x8add0` |
| `setOption("enable_cast","1")` | Ramo de telefone | `0x8ae0a` |
| `startService(TVService)` | Após configurar o singleton | `0x8ae1e` |

Essas arestas históricas não foram novamente decodificadas por REA: `Spark.X0` permanece `native` no DEX atual. Os hashes das bibliotecas foram reconferidos; os arquivos temporários do primeiro mapeamento não estavam disponíveis. A configuração distingue a API de login do aplicativo da autenticação do SDK. Não autoriza substituir endpoints, inventar opções/brokers ou presumir que a engine opere sem o servidor.

## Seleção de fonte e saída local

Os pontos de entrada `Spark.n0(ChannelBean,SourcesBean)`, `Spark.p0(ChannelBean):SourcesBean` e `Spark.h0(Bundle)` são nativos (`flags=0x111`, `code_item=0`). O modelo fornece `sources`, `address`, `address_backup`, `bType`, `mediaType`, duração, bitrate e legendas; a existência de um campo não prova preenchimento pelo servidor nem algoritmo de fallback.

Os relatórios estáticos anteriores do mesmo SHA recuperaram estas arestas, mantidas como evidência histórica:

- `ChannelBean.getDefaultUrl` retorna literalmente `sources[índice].address`; não demonstra conversão universal de protocolos nem escolha inicial do índice.
- `SparkViewModel.playVideo` encaminha `address_backup` ao Bundle em VM `0xbc14c–0xbc154`; `Spark.h0` lê o campo em `0x8ce40–0x8ce56`.
- `Spark.V()` compara o tipo com `Constants.VIDEO_TYPE.BSLIVE` em VM `0x8c2f6–0x8c308`; o ramo de `h0` em `0x8d8e0–0x8d8ec` chama `TVCore.start(url)` em `0x8d986`.
- Não foi demonstrada nesse ramo uma tentativa automática de passar a mesma URI TVBus a `Libtvcar`/BinStream. Tampouco foi recuperada uma correspondência universal entre `bType` e protocolo.

A saída HTTP da engine aparece no parser de callback `Spark.t(Spark,String,String)` (wrapper `0xf455c`, VM `0x8bd8c`): `onPrepared` lê campos `hls` e `http`, em `0x8c064` e `0x8c07c`. A biblioteca atual contém formatos locais de playlist `main.m3u8`/`index.m3u8`, associados a loopback e porta variável, nos offsets de arquivo `0x7522a`/`0x7a950`. Estes dois literais foram reconferidos nos bytes do ELF atual.

Porta configurada, formato de string e callback previsto não são uma playlist entregue. A sequência catálogo → URI nativa → preparação da engine → endereço local efetivamente retornado → bytes de mídia não foi executada nesta investigação. Não há fundamento para sintetizar uma URL reproduzível a partir de ID, esquema ou nome do canal.

## BinStream/Libtvcar

REA fresco de `com.libtvcar.Libtvcar`: `ev_70c3789ec3c6624da6925fc1c4b2df06c911440c1eeedaf0cee8ed63b0cee25b`; `class_def` `classes.dex:0x150f94`. Seu `<clinit>` (`code_item=0x6d2248`) chama `go.Seq.touch()` e `_init()`: `ev_a2b501724eee112a3732caca36672837436a6a99437176215937bcb7d2884498`.

A API declarada possui `init():long`, `run`, `start(String)`, `release`, `getVersion(long)`, `setAuthURL`, `setUsername`, `setPassword`, `setPlayPort(long)`, `setOption` e `setListener`. Esses métodos têm exports correspondentes em `libgojni.so`; o arquivo também contém callbacks `onInited/onStart/onPrepared/onStop/onInfo/onQuit`. Não há método público `stop()` declarado nessa classe: `release()` não deve receber, por suposição, a semântica da TVCore `stop()`.

Os bytes do ELF contêm nomes Go como `binstream/libtvcar.startStream`, `advanceSeedAfterSlowSegment` e `HLS.ServeHTTP`. Nomes preservados indicam partes da implementação; não revelam valores de timeout, duração do buffer, política de peers, frequência de retry, escalonamento ou garantia de fallback. Nenhum destes comportamentos foi reconstruído integralmente nesta sessão.

## Buffers: o que os números realmente representam

Foi inspecionada a implementação **empacotada** de `androidx.media3.exoplayer.DefaultLoadControl`. O construtor sem argumentos (`classes.dex:0x49c0b0`) passa os parâmetros abaixo ao construtor completo (`0x49c0f8`), que valida e armazena cada limite. Evidências frescas `ev_ecdf0161b936721cba6b60a296911f97bae4ca5417897bd99063270a5812540f` e `ev_881c00f590dcd95b928b6f9622632249ca455b4aafe47514f4fa763297cf900a`.

| Parâmetro do construtor padrão | Valor no APK | Limite de interpretação |
| --- | --- | --- |
| `minBufferMs` / `maxBufferMs` | `50000` / `50000` | Defaults da classe; não configuração efetiva comprovada de `Spark`. |
| `bufferForPlaybackMs` | `1000` | Limiar padrão de início; não latência total de canal. |
| `bufferForPlaybackAfterRebufferMs` | `2000` | Limiar após rebuffer, separado de autenticação/peers. |
| `targetBufferBytesOverwrite` | `-1` | Seleção automática pela implementação; não RAM ilimitada. |
| `prioritizeTimeOverSizeThresholds` | `false` | O cálculo de bytes também participa da decisão de carregar. |
| `backBufferDurationMs` / retenção por keyframe | `0` / `false` | Defaults de retenção anterior, não política de cache em disco. |

`shouldContinueLoading(LoadControl.Parameters)` (`0x49c62c`, REA `ev_f0da89dc7706183b1cce539cfcfca0e698882e5e512bac3595c8c5a20f40dc1c`) compara o total alocado com `calculateTotalTargetBufferBytes()`, considera duração de mídia e velocidade, e interrompe carregamento ao atingir duração máxima ou alvo de bytes. Com prioridade temporal desativada, o alvo de bytes pode interromper antes do limiar mínimo temporal.

`getDefaultBufferSize(int)` (`0x49c220`, `ev_085259f98844b00dfb29618f80f34a619bcd1de5407a51757bea6d04a4790f93`) retorna, entre outros ramos, `13.107.200` bytes para os valores `-1` e `1`, e constantes de vídeo/mux nos ramos próprios. A leitura direta do `encoded_array` de valores estáticos da classe (`classes.dex:0x2c61a5`) identifica `DEFAULT_AUDIO_BUFFER_SIZE=13.107.200`, `DEFAULT_VIDEO_BUFFER_SIZE=131.072.000` e `DEFAULT_MUXED_BUFFER_SIZE=144.310.272` bytes. Os offsets de cada valor e o SHA do DEX estão em [buffers-media3-primary.json](buffers-media3-primary.json); [ler_defaults_buffer.py](ferramentas/ler_defaults_buffer.py) reproduz essa extração limitada a constantes numéricas/booleanas. Essa leitura de bytes não é uma evidência REA nem uma medição de alocação.

Esses valores de implementação não certificam o heap total, cache P2P ou limite escolhido pelo aplicativo. Os adaptadores protegidos podem construir outro `LoadControl`, mudar os parâmetros ou usar `VideoView`.

Existem três reservas de dados distintas que não devem ser somadas como um único “buffer” sem medição:

1. Dados temporários/peers e saída da engine P2P nativa.
2. Allocator e filas do player/decoder, incluindo superfície de vídeo e memória nativa.
3. Cache persistente/download offline e armazenamento de metadados/imagens.

A duração de mídia em buffer não determina sozinha bytes de RAM; bytes dependem do bitrate e das camadas acima. Não foi recuperado limite numérico efetivo de RAM, disco ou buffer da TVCore/BinStream. As strings `buffer_size` (`libtvcore.so:0x2eef7`, `0x7cb8f`) e os campos de telemetria `buffer/download_rate/upload_rate` comprovam vocabulário da engine, sem fixar unidade ou capacidade.

Há também retenção de UI independente do buffer de mídia: o Java de `Spark.v()` monta uma lista de fragments condicionada por flags e chama `MyViewPager.setOffscreenPageLimit(g.s.size()-1)` antes de instalar o adaptador. Evidência fresca `ev_1ec33b4e4df7a2ed1b171cbe84d3a3a02a658f76e686db359b74c71391cff0fe`, `classes2.dex:0x186878`. O número concreto depende das flags/configuração. A retenção configurada pode contribuir para manter views/dados associados; não demonstra que cada tela continue consultando rede nem quantifica RAM. Esse custo deve ser distinguido do cache P2P.

## Estrutura ELF e integridade das bibliotecas

Os cinco arquivos abaixo foram lidos diretamente do ZIP principal. Os hashes completos, tamanhos/segmentos e símbolos estão em [elf-arm64-primary.json](elf-arm64-primary.json) e [simbolos-nativos-arm64.tsv](simbolos-nativos-arm64.tsv). O segundo inclui SHA-256 dos bytes de cada símbolo selecionado, sem strings de configuração/conta. O script [inventariar_elf.py](ferramentas/inventariar_elf.py) reproduz a leitura estática, sem loader/JNI.

| Membro ARM64 | Bytes | SHA-256 |
| --- | ---: | --- |
| `libtvcore.so` | 2.544.712 | `23ef3fe420716e95764690f2edd52ec0780c15fe23f0741c7f9b148a790e86ee` |
| `libgojni.so` | 7.568.616 | `57a67d1bbdc61d502766f98958108ae20543e450e3ea0a26dc33dc127bb754dd` |
| `libffmpegJNI.so` | 1.371.000 | `278859a559108dd7927fef447c18b617c9b3593c33c89f07018f3c5f0a70aaf8` |
| `libijkplayer.so` | 1.424.040 | `24bc03762b81bc2bb1919501a0758fce0829d2376a52422351468b7412711187` |
| `libijkcodec.so` | 304.432 | `970e7ab1f95d616435d1f4317a14f81da5465e2a325e4d80b20cfbfaf29984f9` |

| Export selecionado | Biblioteca | ELF VA | Arquivo | Bytes |
| --- | --- | --- | --- | ---: |
| `TVCore_init` | `libtvcore` | `0x1376ec` | `0x1336ec` | 612 |
| `TVCore_start` | `libtvcore` | `0x137a38` | `0x133a38` | 376 |
| `TVCore_start2` | `libtvcore` | `0x137bb0` | `0x133bb0` | 1.056 |
| `TVCore_stop` / `stop2` | `libtvcore` | `0x138258` / `0x138264` | `0x134258` / `0x134264` | 12 / 12 |
| `TVCore_quit` | `libtvcore` | `0x138270` | `0x134270` | 8 |
| `TVCore_setListener` | `libtvcore` | `0x1385d4` | `0x1345d4` | 124 |
| `Libtvcar_init` | `libgojni` | `0x423e0c` | `0x41fe0c` | 52 |
| `Libtvcar_start` | `libgojni` | `0x424028` | `0x420028` | 68 |
| `Libtvcar_release` | `libgojni` | `0x423e40` | `0x41fe40` | 36 |
| `FfmpegAudioDecoder_ffmpegInitialize` | `libffmpegJNI` | `0x75358` | `0x75358` | 196 |
| `FfmpegAudioDecoder_ffmpegDecode` | `libffmpegJNI` | `0x755e8` | `0x755e8` | 392 |
| `FfmpegAudioDecoder_ffmpegRelease` | `libffmpegJNI` | `0x75ef4` | `0x75ef4` | 104 |

Nomes abreviados na tabela correspondem aos exports JNI completos no TSV. Export de `stop` com 12 bytes é um ponto de entrada, não uma prova de liberação síncrona ou confirmação de parada.

Todos os `PT_LOAD` destes cinco ELF ARM64 têm `p_align=16384`. Isso descreve o arquivo, sem certificar instalação/carregamento no Android. No `libffmpegJNI.so`, o último segmento tem `p_filesz=40` e `p_memsz=16.961.984`; a diferença de `16.961.944` bytes corresponde à área zero-fill/BSS. Ela não é 16 MiB de mídia em buffer, nem RSS medido, nem teto total do processo. `largeHeap=true` no manifesto também é uma solicitação/configuração, não uma medição de uso de RAM.

## Lacunas que afetam uma reconstrução fiel

Não estão comprovados: o player selecionado por formato/dispositivo; parâmetros de buffer efetivamente passados por `Spark`; limites de cache da TVCore/BinStream; política completa de retries/peers; fallback entre fontes e engines; unidade do campo `buffer`; coleta/liberação de memória nativa após troca de canal; confirmação de parada; codecs realmente ativos e desempenho/latência em execução.

O [capítulo 06](06-componentes-e-ciclo-de-vida.md) detalha o que o teardown Java realmente cancela e onde há fronteira nativa. Esta análise não estabelece uma relação causal entre caches locais do APK e CPU/consulta de logs do Supabase: isso exigiria rastrear o sistema integrado, sem converter strings ou presença de bibliotecas em tráfego observado.
