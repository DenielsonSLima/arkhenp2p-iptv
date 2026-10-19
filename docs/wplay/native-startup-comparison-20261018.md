# Preparação nativa WPLAY e abertura web

Data: 18/10/2026. Escopo: leitura estática do APK original, evidências preservadas e código público. Sem executar APK/JNI, navegador, espelhamento, autenticação ou mídia nesta revisão. Nenhum player foi alterado.

## Alvo e fontes

`WPLAYP2P.apk`, versão 11.9.0d/1190, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. O SHA foi novamente conferido pela leitura local de bytes. O DEX examinado é `classes.dex`, SHA-256 `288b1a547c148add3c7832844095be31d70b7148815dd4a3fde2d31ea6beea7b`.

Evidências anteriores do mesmo artefato permanecem em [reprodução e memória](../engenharia-reversa-wplay-20261016/05-reproducao-e-memoria.md), [ciclo de vida](../engenharia-reversa-wplay-20261016/06-componentes-e-ciclo-de-vida.md), [índice de evidências](../engenharia-reversa-wplay-20261016/evidencias-reproducao.json) e [constantes Media3](../engenharia-reversa-wplay-20261016/buffers-media3-primary.json). Reutilizá-las não constitui nova observação em execução.

## START, preparação e primeiro quadro são etapas distintas

| Etapa | Evidência estática do APK | Limite da comparação web |
| --- | --- | --- |
| Configuração da engine | `TVServer.run()` passa playPort 8902, servPort 0 e runningMode 1 antes de init/run. REA `ev_37dd39ac2912ac00e89a9340304ec741502219b01ed93b2ed9b672917014ca5d`. | Porta e init não provam fonte preparada ou quadro exibido. |
| Seleção | Evidência histórica do mesmo SHA registra `sources[índice].address` e chamada TVCore.start. Os pontos Spark.n0/p0/h0 são protegidos. | Não demonstra seleção automática da maior qualidade, nem conversão universal de TVBus para HTTP remoto. |
| `onPrepared` | A reconstrução histórica de Spark.t lê campos `hls` e `http` em VM 0x8c064/0x8c07c. O DEX atual declara esse método native, sem corpo Java. | Preparação da engine pode fornecer endereço local ao decoder; receber esse endereço não comprova decodificação ou primeiro quadro. |
| Player | Adaptadores Media3 `te.d` e VideoView `te.e` possuem implementações protegidas. Evidências `ev_9379cc1ba5e95decc47639981b12f39facd548e4e6fe7ab7e3d39fb46de262f8` e `ev_88fc53b51e3cbc8b71eb60e1a0b43295ec0b4757be57383fb19932faa0738356`. | Presença do ExoPlayer não identifica o ramo utilizado por um canal. |
| Parada | Existem stop/release/quit e callbacks diferentes nas interfaces. Parte da ordem depende de JNI. | Não assumir confirmação síncrona, política de geração ou STOPHTTP a partir dos nomes dos métodos. |

O web ARKHEN consome HTTP autorizado; sua composição está em `lib/wplay/conexao/reproducao.mjs`, `ao-vivo/transporte-web.mjs` e `ott/provedor.mjs`. Mantém seleção, sid/gen e STOP do contrato web, não da engine Android. A comparação pertinente está em [reprodução oficial](reproducao.md): STOP POST exige 204, há intervalo restante de 3 s entre gerações e cancelamento invalida seleções substituídas. Falha de catálogo, preparação, playlist, segmento e decoder precisa permanecer distinguível.

## Buffer: o que se sabe e o que não foi recuperado

Os construtores Media3 preservados mostram defaults de 50 s para min/maxBuffer, 1 s para iniciar, 2 s após rebuffer e prioridade temporal false. Evidências dos construtores: `ev_ecdf0161b936721cba6b60a296911f97bae4ca5417897bd99063270a5812540f` e `ev_881c00f590dcd95b928b6f9622632249ca455b4aafe47514f4fa763297cf900a`. O método shouldContinueLoading também considera o alvo de bytes: `ev_f0da89dc7706183b1cce539cfcfca0e698882e5e512bac3595c8c5a20f40dc1c`.

Consequentemente, 50 s não é uma espera inicial comprovada. Também não se pode afirmar que 1 s é o limiar efetivamente configurado pelo WPLAY: o adaptador pode construir outro LoadControl ou escolher VideoView. O código público atual do [DefaultLoadControl](https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/DefaultLoadControl.java) separa condição de início, alvo de carregamento e alvo de latência live. Esse upstream é referência de semântica, não prova da versão/configuração do APK.

O inventário anterior identifica três overloads de shouldStartPlayback, sendo o índice 2 o que recebe LoadControl.Parameters. A tentativa focada atual não recuperou seu corpo: o MCP não tinha o JAR configurado; o launcher local com o JAR/JDK existentes foi bloqueado ao compilar o helper Swift em cache fora do sandbox. Não foi criada nova EvidenceREA de método, instalado software ou alterado registro global. A política exata desse método no artefato continua uma pendência.

No código web local, `web/tv/buffer.js` distingue orçamento máximo, margem live e quantidade inicial de segmentos. A documentação primária do [HLS.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md?plain=1) distingue initialLiveManifestSize, número mínimo de segmentos para iniciar carregamento, de maxBufferLength, alvo de buffer. Essas opções não certificam o comportamento do player nativo Safari. Aumentar o orçamento máximo não demonstra que o primeiro quadro ficará mais rápido.

## Nova leitura numérica: HTTP do Media3 empacotado

Foi reutilizado o parser local `ferramentas/inventariar_dex.py` para ler somente valores numéricos estáticos da classe `Landroidx/media3/datasource/DefaultHttpDataSource;`. Sem execução de DEX, extração de strings/configuração ou REA inventada:

| Constante | Valor | Offset no DEX |
| --- | --- | --- |
| DEFAULT_CONNECT_TIMEOUT_MILLIS |8000 ms|0x2c5c82|
| DEFAULT_READ_TIMEOUT_MILLIS |8000 ms|0x2c5c85|
| MAX_REDIRECTS |20|0x2c5c8e|

Class_def 0x132a14; encoded_array 0x2c5c81. São defaults da biblioteca empacotada. Não provam que TVCore use esse cliente, que o adapter preserve esses valores ou que o timeout cubra a preparação inteira. No ARKHEN, `requestUpstream` usa timeout de inatividade do request Node; políticas de prazo total do loader web são uma camada separada.

Não foi demonstrada uma opção TCP/HTTP/cache da TVCore que possa ser transferida ao navegador. A superfície setOption e strings buffer_size não determinam unidade, valor efetivo ou transporte. O cache ACache de metadados e o cache de downloads VOD também não provam cache de mídia live. Referência: [armazenamento](../engenharia-reversa-wplay-20261016/02-armazenamento.md).

## Consequências limitadas

1. Não transportar defaults Android para o web como correção presumida de latência.
2. Preservar as fases preparação→playlist→segmentos→decoder→quadro e separar tempos de checkpoint/fila dos tempos de rede.
3. Somente uma fonte HTTP recebida legitimamente, ou uma saída efetivamente fornecida pela engine, comprova endereço utilizável; nomes de campos e esquemas não autorizam derivá-lo.
4. Erros 503 de grade, imagens ou detalhes pertencem à investigação de sessão/cloud/rotas. Esta comparação estática não fornece uma causa APK para esses erros.

Questões abertas: LoadControl efetivo do adaptador protegido; relação completa entre callbacks e geração; opções e cache reais da TVCore; transporte utilizado pelo aplicativo IPTV iOS mostrado pelo usuário. Esta revisão não mede abertura ou continuidade em nenhum deles.
