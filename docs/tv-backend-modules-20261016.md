# Backend de TV e evidência do APK

Data: 16/10/2026. Escopo: TV ao vivo. Esta etapa separa implementações existentes e extrai o inventário autorizado de fontes; não altera o caminho de Filmes/Séries, não instala runtimes e não certifica reprodução.

## Responsabilidades implementadas

| Módulo | Responsabilidade e limite |
| --- | --- |
| `lib/tv/fontes.mjs` | Normaliza fontes nativas/OTT, conserva índice original, gera descritores públicos e IDs opacos, ordena a qualidade anunciada e valida seleção. Endereços permanecem em entradas privadas. |
| `lib/tv/inventario-fontes-wplay.mjs` | Consulta o canal autenticado e combina somente suas fontes fornecidas com a associação web permitida. Listar fontes não inicia nem para engine. |
| `lib/tv/resolver-web.mjs` | Associa catálogo nativo e OTT por identidade explícita ou título completo conservador e único. Números/regiões permanecem significativos; identidade ambígua é recusada. |
| `lib/tv/transporte-web.mjs` | Contém `WplayWebPlayback`: fila por sessão, cancelamento, preparação OTT e propriedade de manifests/segmentos. Não fornece IDs de biblioteca ou catálogo. |
| `lib/tv/conector-supabase.mjs` | Leituras de EPG/grade, limites de concorrência e caches próprios da TV. Não autentica o provedor, provisiona Auth, agenda coleta ou controla mídia. |
| `lib/tv/grade-compartilhada.mjs` | Coalesce EPG por partição/canal e lê lotes de até80 IDs, preservando programa ainda vigente durante falha. |
| `lib/tv/grade-runtime.mjs` | Reutiliza a projeção calculada no servidor por partição/modo adulto/fuso e filtra os canais solicitados. Snapshot anterior permanece explicitamente desatualizado em falha. |
| `lib/tv/grade-legada.mjs` | Alternativa transitória de metadados já publicados. Lê catálogo e EPG em lote, valida cobertura e calcula janela no backend; identifica a resposta como `legacy-cache`, parcial e desatualizada. Não consulta WPLAY nem engine. |

`CloudRuntime` mantém os métodos públicos `epg(state,id)` e `tvGuide(state,options)`, delegando ao conector em `this.tv`. Provisionamento, catálogo de outros domínios e biblioteca pessoal permanecem com seus donos anteriores. Solicitar uma atualização EPG invalida somente o cache EPG correspondente; fila de coleta e fila de reprodução continuam responsabilidades distintas.

Os módulos antigos `live-source-options.mjs`, `shared-live-epg.mjs`, `tv-guide-runtime.mjs`, `tv-guide-compat.mjs` e `wplay-web-playback.mjs` são fachadas documentadas para consumidores existentes. A implementação e o estado existem somente nos módulos canônicos de TV; não há cópias paralelas dos caches ou transportes.

## Interfaces

```js
const tv = new ConectorTvSupabase({
  cloud, now, maxReadEntries, maxEntries,
  isEnabled: () => runtime.enabled,
  isClosed: () => runtime.closed
});
tv.epg(state, channelId);
tv.guide(state, {ids, includeAdult, timeZone, fresh});
tv.invalidate(providerKey, scopeHash);
tv.close();

const inventory = await inventarioFontesWplay({
  client, id, signal, web, nativeEnabled
});
// inventory: {item, raw, entries}; contém fontes privadas, somente backend.
// liveSourceCatalog(id, entries) produz o DTO público sem endereços.
```

O conector captura cliente, identidade, geração Auth e, na grade, epoch/PIN antes dos awaits. Uma leitura rejeitada não cria novo login. A RPC de grade usa o transporte confiável já existente; a alternativa legada usa o JWT do espectador e permanece submetida à autorização da sessão.

Os providers mantêm `liveSources(id,{signal})` e `playbackURL(type,id,container,{sourceId,attempt,signal})`. O inventário foi retirado do provider misto; a seleção e o transporte continuam vinculados à intenção de abertura. Rotas compartilhadas de play/stop/status/proxy não foram extraídas nesta parte, pois também atendem VOD.

## Contratos preservados

- `sourceId`, revisão e ID de canal conservam os mesmos algoritmos. A troca de fonte não altera favoritos/histórico.
- HTTP só é aceito quando entregue pelo provedor e aprovado pela fronteira de rede. `address_backup` só entra como alternativa HTTP efetivamente fornecida. TVBus e TVCarS continuam protocolos diferentes; nenhum endereço HTTP é fabricado.
- O bridge TVCore recebe somente a URI TVBus exata selecionada quando o modo nativo foi explicitamente configurado. O bridge genérico permanece no módulo compartilhado, pois também era usado por VOD.
- A fila OTT continua no cliente da sessão, com `sid/gen`, parada confirmada204, prazo12s, intervalo mínimo3s entre gerações, primeira abertura imediata, cancelamento e falha de parada retida. Esta etapa não reimplementa esses mecanismos.
- 429, autorização, geração encerrada e falha estrutural continuam separados da seleção de qualidade. Qualidade declarada não é resolução audiovisual medida.

## Evidência do APK e limites

O APK selecionado é `WPLAYP2P.apk`, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. O REA MCP confirmou esse alvo e executou `inspect_artifact` nesta etapa:

- Evidence da inspeção: `ev_7165955158c69adafa7a27e1fbcb99199bc9192c84fbf3cdac36d9f1d86fed5d`.
- Evidence do inventário: `ev_ac4f019c9afc50ceae48351ff2b8aaeb2f3d6f397e7373df9e1d1ca5b8599afc`.
- 2.463 membros ZIP, dois DEX (`classes.dex` e `classes2.dex`) e nenhum membro com extensão JS/HTML/WASM. O inventário identifica bibliotecas ARM64 TVCore, GoJNI e IJK; presença de biblioteca não demonstra caminho executado.
- A cobertura é o diretório central ZIP. O REA registra colisões de nomes sob comparação case-insensitive e não verifica assinatura APK nesta operação.

Na primeira chamada, `inspect_android_package` retornou `capability_unavailable`: faltava o JAR externo `jadx-headless-mcp 0.7.1`, selecionado por `REA_JADX_MCP_JAR`. A sessão de inventário ZIP foi encerrada. O bloqueio de dependência foi reparado posteriormente, conforme a extração atual documentada abaixo.

Uma conferência complementar limitada das ferramentas locais, em 16/10/2026, anterior à obtenção autorizada do JAR, confirmou:

- `command -v jadx`, `command -v apktool` e `command -v rea` não encontraram executáveis no PATH. Isto não significa que o REA esteja ausente: o MCP ativo informa `rea-agents 6.4.0`, executado pelo cache npm/npx já existente.
- `command -v java` encontrou `/usr/bin/java`. `/usr/libexec/java_home -V` enumerou JBR 21.0.11 ARM64; seu arquivo `jmods/jdk.compiler.jmod` existe. Naquele momento, o bloqueio era o provider JADX ausente, não ausência de Java.
- `REA_JADX_MCP_JAR` está sem valor no ambiente inspecionado. Não foram encontrados JARs de JADX/APKTool nos diretórios conhecidos do REA (`~/.config/rea`, `~/.local/share/rea`, `~/.cache/rea`, `~/.codex/rea`), nos caminhos padrão Homebrew de JADX/APKTool em `/opt/homebrew` e `/usr/local`, nem nos diretórios locais `.local/rea`, `.local/tools` e `.local/apk-tools`; esses caminhos estão ausentes.
- Foram inspecionados, sem executar conteúdo, o pacote efetivo `rea-agents` já instalado no cache npm/npx, `~/.local/bin`, a skill de engenharia reversa e `tools/` do projeto. A busca limitada por executáveis `jadx`/`apktool` e JARs correspondentes não encontrou alternativa. O pacote REA percorreu 109 diretórios, sem atingir o limite de 500; profundidade máxima 6 e saída máxima 30 correspondências. As demais buscas também ficaram dentro dos limites declarados.

Esta foi uma busca negativa delimitada aos caminhos acima, não uma varredura de todo o computador. Nenhum decompilador estático reutilizável foi encontrado naquele inventário, anterior à autorização de obtenção local do JAR.

### Extração atual com dependência reparada

Como dependência ferramental da engenharia reversa já autorizada, foi baixado o [JAR oficial `jadx-headless-mcp 0.7.1`](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1) para `.local/tools/`. O artefato tem 42.619.858 bytes e SHA-256 `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`, idêntico ao pin de `dist/android/JadxRelease.js` e à proveniência `third_party/README.md` do REA 6.4.0 instalado. A revisão upstream registrada é `5844800a486d2248fa949b74c9896285f5b54de2`. Não foram instalados SDK, emulador, runtime Android ou outro decompilador.

O CLI REA já existente foi executado com `REA_JADX_MCP_JAR`, `JAVA_HOME` e limite de heap apenas no processo: um worker e 768 MiB. A primeira tentativa foi bloqueada pelo sandbox ao compilar o helper macOS do REA em cache Clang; a execução estática autorizada fora do sandbox resolveu esse bloqueio. Nenhuma configuração global do REA foi criada ou alterada.

`inspect_android_package` concluiu com Evidence `ev_b8d03dbae27b78f6eec1f14809debe894ee76ff4f2aa3499b49ee0fff4340c3f`: pacote `io.wareztv.android.one`, versão `11.9.0d`/1190, 7.977 classes e 2.463 recursos, com o SHA do alvo acima. Isto é inspeção estática; a assinatura APK não foi verificada.

A busca geral `search_android_classes` foi recusada pelo validador REA porque o produtor devolveu 7.977 itens e 7.976 nomes únicos, duplicando `okio.SegmentedByteString`. As respostas parciais preservam os nomes candidatos, mas não são resultado de busca certificada completa. A inspeção direta das classes identificadas funciona sem esse passo; o REA e o APK permaneceram intactos.

| Extração atual pelo REA | Observação estática específica |
| --- | --- |
| `ChannelBean`, Evidence `ev_cffac46faeb24c4ed30704f057a35f3209998fbbdefd17350ee6d2307b3ca3cc` | Declara `sources: List<ChannelBean$SourcesBean>`, `sid: int`, `epg: List<EpgBeans>` e `epgSameAs: int`. Expõe `getSources`, `getDefaultUrl`, `getSourceList`, `getSid` e `setSid`. |
| `ChannelBean.SourcesBean`, Evidence `ev_a46eb48d11eea39be2205f33e8044657a720794007cec186348a72784f843dcd` | Declara `address`, `address_backup`, `subTitle`, `kbps`, `mediaType`, `bType`, `qs`, `duration`, identificador e `qc`. O JADX renomeia os campos de colisão na apresentação; o smali conserva os nomes originais `id` e `qc`. |
| `EpgBeans`, Evidence `ev_3a87c256bbdcaea5b477e21de857f0b7bd67e3696af81e0a21293c585c8e2bb5`; `EpgBeans.EpgBean`, Evidence `ev_04d588b89b95666e2be6099ff3e2cfb3d4d34f776607c4b517c5d8b867afd9b8` | O envelope conserva identificador, `hasPlayBack` e lista `epg`; o item declara `name`, `time: Long`, `endTime: Long`, identificador e `playbackUrl`. Estes tipos não demonstram unidade de tempo, atualização da grade ou oferta de replay para uma conta. |
| `TVCore`, Evidence `ev_aa933a3331d7b27993008211a507bd69ac3be0876a945289e99b425b56eefc20` | Possui `nativeHandle`, listener e métodos de autenticação/portas/configuração. Declara três overloads `start`, três `stop` e o `start2` interno; seleção do overload foi baseada no inventário, sem presumir assinatura. |
| `ChannelBean.getDefaultUrl`, `getSourceList`, `getSid`: Evidence `ev_550b799fcb044f8a6101b5b191664a2b3fd68f1c4faced7e2e1d0c3bffd231fd`, `ev_7237b4f5b53df3adf2f3efee61c6e5e7a1ea972ea6527fb69b469484775d7355`, `ev_28dbb527a1bf369e600e00104c4f88d4242d1ab695571479882524b5671aa3ff` | O REA identifica cada método, mas retorna `body_status: not_available`, sem corpo Java. Não foi recuperada nesta etapa uma implementação Java que selecione o índice ou ordene qualidades. |
| `TVCore.start(String)`, overload 1, Evidence `ev_5a3f9ebb6ffab2b2205e2029ae7c6c9d1873d137ef05ce6f78f4129ebabfd603` | Também retorna corpo indisponível. O inventário de declaração comprova a interface, não a implementação do transporte nem o protocolo de um endereço recebido. |

Para distinguir corpo protegido de falha do decompilador, a API JADX contida no mesmo JAR verificado foi usada em um helper temporário local que apenas carrega metadados DEX e chama `getSmali()`. Foram extraídas somente as três classes externas `ChannelBean`, `EpgBeans` e `TVCore`, incluindo suas classes internas. Nenhuma classe do APK foi carregada como classe executável da JVM. Esse passo é evidência estática complementar fora do envelope REA; seus SHA-256 permitem conferir os resultados:

| Smali produzido em `.local/analysiscurrent/tv-apk-static/` | SHA-256 |
| --- | --- |
| `org.bitspark.android.beans.ChannelBean.smali` | `44a0276d13c77bbfd35aaebc245ecc345994909640c8ecb485e2312f092a7bc7` |
| `org.bitspark.android.beans.EpgBeans.smali` | `719740da499a7c28dd0bca76ae9b4c8327d6bff79b69aaf08a704a31f368af9c` |
| `com.tvbus.engine.TVCore.smali` | `f2acb95ce9f7d1bb0abd599e3733b2bac00feb04ae0597aa05a705b300808be2` |

O smali confirma `public native` (`0x101`) em `getDefaultUrl`, `getSourceList`, `getSid`, `ChannelBean.getEpg` e `TVCore.start(String)`. O inicializador estático TVCore referencia `com.nmmedit.protect.NativeUtil.classesInit0` e `System.loadLibrary("tvcore")`; essas instruções foram lidas, nunca executadas. Os getters de `SourcesBean.getSubTitle()` e `getAddress_backup()` possuem corpo DEX comum e apenas devolvem os respectivos campos. O getter `EpgBean.getTime()` também devolve seu campo diretamente. Assim, a dependência de análise está reparada; o limite atual são os métodos declarados nativos e o escopo estático escolhido, não a ausência de JADX.

Os construtores DEX recuperados de `ChannelBean` preservam a lista recebida e não atribuem `sid`. Isso é compatível com o valor inicial padrão de um campo `int`, mas não comprova qual índice o controlador atribui antes de abrir um canal. A maior qualidade inicial, a troca em rebuffer e o fallback de engine não foram observados em execução. O valor interno `JadxDecompiler.getVersion()` reporta `dev`; a identidade verificável da distribuição usada é o JAR upstream 0.7.1 e seu hash, não uma versão adicional inferida do núcleo JADX.

As observações comportamentais históricas abaixo vêm dos relatórios estáticos anteriores do mesmo SHA, datados de13–15/10/2026; devem ser distinguidas das extrações atuais:

| Observação | Fonte verificável no relatório |
| --- | --- |
| O catálogo live é convertido em `ChannelBean[]`; cada canal conserva `sources[]`. | `analysis/WPLAYP2P-11.9.0d-auth-contract.md`, seção Catálogo e reprodução: worker `i0.run`, DEX `0x6f7c68`, chamada parseArray em `0x6f7c9a`. |
| `SourcesBean` declara `address`, `address_backup`, `subTitle`, `kbps`, `qc`, `qs`, `bType` e outros campos. Existência não comprova que a conta os receba. | `analysis/WPLAYP2P-11.9.0d-live-http-alternatives.md`, getter `getAddress_backup`, DEX `0x18b190`. |
| `getDefaultUrl()` devolve literalmente `sources[índice selecionado].address`. | `analysis/WPLAYP2P-11.9.0d-auth-contract.md`, helpers de `ChannelBean`. Isto não demonstra seleção inicial da maior qualidade pelo APK. |
| A fonte backup é transportada no fluxo de seleção, sem comprovar fallback HTTP disponível. | Relatório de alternativas live: VM `0xbc14c–0xbc154` e `0x8ce40–0x8ce56`. |
| O ramo live observado chama `TVCore.start(url)`. Não há fallback automático BinStream demonstrado nesse trecho. | Mesmo relatório: `Spark.V` em `0x8c2f6–0x8c308`; chamada TVCore em `0x8d986`. |
| `onPrepared` oferece `hls/http` depois que a engine prepara o stream. | Mesmo relatório: leituras em `0x8c064` e `0x8c07c`. Isto não fornece um catálogo HTTP alternativo público. |

`subTitle` é texto fornecido pela fonte. Um rótulo HD/FHD/4K não comprova dimensões, bitrate medido, estabilidade ou ABR. A política ARKHEN de começar pela maior qualidade anunciada compatível é uma decisão do produto solicitada nesta rodada, não uma reprodução comprovada da política inicial do APK. A cadência e o cálculo atuais da grade central também são contratos do ARKHEN/Supabase, não inferências sobre execução Android.

Os dumps auxiliares históricos mencionados em `/private/tmp/wplay-apk-20261013` não estão mais disponíveis nesta sessão. Seus offsets e relatórios continuam sendo referência histórica; o JAR ausente deixou de ser um bloqueio da inspeção atual.

## Verificação

Na implementação dos módulos, foram feitas leitura do diff, checagem `node --check` dos módulos alterados, conferência estática de imports/exports por bundles esbuild do conector e do provider WPLAY para `/private/tmp/arkhen-tv-modules-static`, e `git diff --check`. Nenhum bundle foi executado. Nesta complementação, foram conferidos os hashes do alvo, JAR e smali, os envelopes REA e as declarações DEX focadas. Não houve testes, navegador, streaming, execução Android, restart, SQL ou deploy. Tempo de abertura, qualidade recebida e estabilidade audiovisual continuam dependendo da validação do usuário.
