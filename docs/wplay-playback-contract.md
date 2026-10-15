# Reprodução WPLAY: APK e player web

Inspeção estática realizada em 15/10/2026 no APK original WPLAYP2P 11.9.0d, versão 1190, pacote `io.wareztv.android.one`. SHA-256: `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. O APK não foi executado nesta inspeção. Nenhum Android, ADB, login ou engine foi iniciado. A preparação Android anterior está interrompida; houve criação de metadados de um AVD, sem boot.

## O que está dentro do APK

O ZIP contém 2.463 entradas, dois DEX e bibliotecas Android nas ABIs `arm64-v8a` e `armeabi-v7a`. Não contém arquivos `.js`, `.html` ou `.wasm`. Os assets identificados são fontes e perfis de otimização DEX. Isso não comprova ausência de recursos remotos dinâmicos; significa que nenhuma engine web redistribuível foi encontrada dentro deste APK.

| Componente | Contrato observado | Plataforma |
| --- | --- | --- |
| TVBus | `com.tvbus.engine.TVCore`, `TVService`, `TVListener`, `libtvcore.so` | JNI Android ARM64/ARMv7 |
| BinStream | `com.libtvcar.Libtvcar`, `Listener`, `go.Seq`, `libgojni.so` | Go mobile/JNI Android ARM64/ARMv7 |
| Player de mídia | Media3 e bibliotecas IJK/FFmpeg | Android |
| WebView | Legendas HTML do Media3, interface H5 de crash reporting Bugly, telas Countly | Recursos auxiliares; nenhuma engine web de TV identificada |

As chamadas DEX `WebView.loadData`, `loadUrl`, `addJavascriptInterface` e `setJavaScriptEnabled` encontradas pertencem a esses componentes auxiliares. Métodos protegidos declarados como nativos não são evidência de um frontend web. Não foi localizada uma API pública de engine web no APK.

## TVBus

O DEX original carrega `tvcore` em `TVCore.<clinit>` (`classes.dex`, offset `0x700f0c`). `getInstance()` em `0x700f60` aloca o handle por `initialise()`. `TVService$TVServer.run()` em `0x701028` chama `setPlayPort(8902)`, `setServPort(0)`, `setRunningMode(1)`, `init(Context)` e, após retorno zero, `run()`.

O contrato inclui configuração de listener, URL de autorização do SDK, usuário/senha, opções, broker opcional, `start(String)`/`start(String,String)`, `stop()`/`stop(int)` e `quit()`. Os callbacks são `onInited`, `onStart`, `onPrepared`, `onStop`, `onQuit` e `onInfo`, com payload textual. A biblioteca contém os formatos de saída HTTP locais `http://127.0.0.1:%d/%u/main.m3u8`, `index.m3u8` e `mpegts_live`. Essas são saídas produzidas pela engine; não são uma conversão textual de `tvbus://` em uma URL remota.

SHA-256 ARM64 de `libtvcore.so`: `23ef3fe420716e95764690f2edd52ec0780c15fe23f0741c7f9b148a790e86ee`. O contrato antigo e a restrição de certificação da ponte própria estão registrados em [native-bridge/README.md](../native-bridge/README.md). Essa inspeção não alterou assinatura, certificado, autenticação, autorização nem DRM.

## BinStream

`go.Seq.<clinit>` carrega `gojni` (`classes.dex`, `0x7300f0`). `Libtvcar` expõe `init()`, `run()`, `release()`, `setAuthURL(String)`, `setUsername(String)`, `setPassword(String)`, `setOption(String,String)`, `setPlayPort(long)`, `setListener(Listener)` e `start(String)`. Os seis callbacks do listener têm os mesmos nomes de eventos do TVBus.

A biblioteca contém símbolos `binstream/libtvcar.*` e a sequência de protocolo `tvcars://`. A presença de código HTTP/WebSocket da biblioteca padrão Go não transforma o ELF Android em JavaScript ou WebAssembly. SHA-256 ARM64 de `libgojni.so`: `57a67d1bbdc61d502766f98958108ae20543e450e3ea0a26dc33dc127bb754dd`. Não foi comprovado neste trabalho qual canal seleciona BinStream.

## Caminhos HTTP existentes

1. O provedor nativo usa a autenticação WPLAY observada no APK e os endpoints retornados em `service` para catálogo e detalhes. `sources[].address` pode oferecer HTTP(S). [WplayProviderClient](../lib/wplay-provider.mjs) percorre todas as fontes e prefere HTTP(S) válido; somente a ausência de HTTP gera `WPLAY_NATIVE_ENGINE_REQUIRED`.
2. [WplayPlaybackProviderClient](../lib/wplay-playback.mjs) compõe o HTTP nativo com o transporte web privado de TV. No modo web padrão, uma fonte ao vivo `tvbus://` sem HTTP consulta o player OTT oficial. Erro OTT não inicia Android. A ponte anterior permanece disponível somente no modo nativo explícito; a ausência dela explica o antigo `NATIVE_BRIDGE_UNAVAILABLE`.
3. O [player web oficial confirmado pelo usuário](https://player.wplayott.com/auth) oferece um caminho separado. [WplayOTTProviderClient](../lib/wplay-ott-provider.mjs) implementa o contrato RPC web, sessão por cookie/Bearer, catálogo `rows[].items[]`, `liveVariants` e `playbackUrl`. As URLs de vídeo efetivas vêm da resposta autorizada do serviço. O navegador consome HTTP/HLS; não precisa receber as bibliotecas Android.

O ID nativo `405` não está embutido no APK como descrição de um canal. O canal e sua fonte vêm do catálogo autenticado. A falha atual de TV405 entrou no ramo da ponte nativa, segundo o diagnóstico do backend. Esta inspeção não reproduziu nem certificou a transmissão desse canal.

O caminho prático para um backend WPLAY sem Android é integrar o HTTP autorizado do player oficial. Não há SDK web extraível comprovado neste APK, nem documentação pública de SDK encontrada que autorize recompilar/redistribuir as bibliotecas como engine universal. A integração não deve inventar URL de vídeo, decifrar proteção ou alterar verificações do aplicativo.

## IDs e preservação da biblioteca

O provedor nativo conserva `chid`/`id` numéricos. O adaptador OTT atual gera IDs numéricos a partir de SHA-256 de chaves como `item:live:<raw.id>:quality:<quality>`. Esses IDs não possuem equivalência matemática com o ID nativo. Mudar o provedor principal também mudaria `accountLibrarySession`, `providerKey` e o namespace da biblioteca. Os testes OTT existentes usam IDs sintéticos e não comprovam a forma dos IDs do catálogo real.

A composição implementada mantém autenticação, catálogo, IDs, favoritos, histórico e escopo Supabase nativos. [WplayWebPlayback](../lib/wplay-web-playback.mjs) fornece somente o transporte HTTP do canal ao vivo que precisa de fallback. O frontend continua selecionando `live:405`; o ID OTT não substitui o ID salvo. Isso dispensa migração de favoritos ou fusão de contas.

Uma associação de canal exige primeiro um identificador de origem explicitamente compartilhado pelos dois contratos. Não interpretar dígitos encontrados em UUIDs, hashes ou URLs como prova de equivalência. Se esse vínculo não existir, aceitar somente correspondência única de nome completo normalizado e qualidade explícita. Normalizar Unicode, caixa e espaços; conservar regiões, afiliadas, índices de canal/programa, números e demais qualificadores. Remover um sufixo de qualidade apenas quando reconhecido como tal e comparar a qualidade separadamente. Duplicatas idênticas de categoria podem ser deduplicadas pela identidade do provedor. Conflitos, nomes parciais e qualidade ambígua devem permanecer sem associação automática.

O resolvedor atual exige nome completo único no catálogo autorizado e mantém a associação somente na sessão privada. Ele prefere a variante HD do mesmo canal, como o player oficial, ou a primeira variante fornecida. Não há cache global de aliases. Um eventual cache futuro deverá guardar apenas escopos, IDs públicos, qualidade, método, revisão e validade; nunca URLs de reprodução, cookies, Bearer ou senhas.

## Verificação e limites

Em 15/10/2026, 44 testes locais da composição passaram, com servidor HTTP/RPC de teste: HTTP nativo/VOD sem inicializar OTT, associação sem confundir regiões/índices, recusa de duplicatas ambíguas, sessão `sid/gen`, stop remoto, cancelamento de resposta tardia, dois usuários independentes e remoção de credenciais no logout. O modo web não inicia a ponte Android mesmo se uma configuração antiga existir. Headers de autenticação ficam na origem OTT e não seguem para CDN.

Esses testes comprovam o contrato e o isolamento locais. A transmissão real do canal 405 com a conta WPLAY ainda não foi confirmada após a implementação. A senha não é guardada na fonte criptografada do coletor, e o trabalho não extrai senhas do navegador ou da memória de outro processo.

## Correção de abertura e recuperação ao vivo em 15/10/2026

O player tinha um orçamento inicial HLS menor que o necessário para autenticação e catálogo OTT. A composição podia gastar duas chamadas de 20s antes de pedir o manifesto; o cliente desistia antes e iniciava outra tentativa. O transporte agora propaga o sinal de cancelamento até login, login legado e catálogo, e compartilha um limite total de 40s nessa preparação. O erro de prazo é `WPLAY_WEB_START_TIMEOUT`/504, sem URL ou credenciais. Uma tentativa cancelada deixa de bloquear a fila até o servidor remoto responder. A seleção seguinte conserva os controles de sid/gen e stop remoto.

Requisições HEAD e GET simultâneas para o mesmo canal passam a compartilhar a intenção de reprodução, desde que a geração e a autenticação ainda sejam as mesmas. Antes, a segunda requisição invalidava a primeira com 409 mesmo sem troca de canal. Trocar efetivamente de canal, parar, bloquear o controle parental e sair continuam invalidando as respostas antigas. Nenhuma permissão parental foi reduzida.

Falhas HTTP e de transporte em segmentos também chegam ao diagnóstico do servidor. Os eventos contêm somente tipo de mídia, código e status; fontes, tokens, nomes de conta, IDs de títulos e cabeçalhos não são registrados. Interrupção por stop/cancelamento do usuário não é tratada como queda de segmento.

Verificação interna: 60 testes de transporte, OTT, proxy e sessões passaram, incluindo cancelamento de login antes da resposta, prazo de catálogo seguido de nova tentativa, leitores simultâneos e troca real de canal. A regressão adicional de diagnóstico de segmento passou no conjunto de quatro testes correspondente. Revisão independente não encontrou alteração indevida de sessão ou isolamento. A transmissão real e sua estabilidade prolongada continuam exigindo validação da fonte com a conta em uso; os fixtures não representam confirmação audiovisual.

O bundle público oficial `watch-BeOQGf_-.js`, consultado sem login nesta data, confirmou uso de sid/gen e stop por POST e configuração HLS ao vivo com lowLatencyMode desativado e quatro segmentos de margem. Esse contrato público orienta a integração; nenhum conteúdo privado foi extraído.
