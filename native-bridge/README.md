# Ponte Android P2P local

**Estado verificado:** a ponte carrega JNI e autentica a engine (`initReturn=0`,
`auth=0`, `tvcore=0`), mas a reprodução foi rejeitada com `errno=-120`.
A biblioteca exige um certificado de assinatura autorizado: o certificado do
APK original passa na verificação, o da ponte própria não. Não houve HLS
preparado nem reprodução comprovada pela ponte. Consulte
[`WPLAYP2P-11.9.0d-sdk-certification.md`](../analysis/WPLAYP2P-11.9.0d-sdk-certification.md).
Nenhuma validação de certificado foi alterada.

Foi compilado um APK próprio em `build/arkhen-tvbus-bridge.apk`, pacote
`io.arkhen.p2p.bridge`. Ele contém a biblioteca ARM64 **libtvcore.so original do
WPLAYP2P 11.9.0d**, uma facade Java dos exports JNI com handle e um serviço local
sem Activity ou tela de login. O build não instala nem executa o APK, não inicia
Android e não cria/altera AVDs.

```sh
python3 native-bridge/build.py
```

O build usa Java 21, API Android 36 e as ferramentas já instaladas em
`~/Library/Android/sdk/build-tools/36.0.0`: javac, d8, aapt2, zipalign e apksigner.
O relatório de compilação fica em `build/build-report.json`. A assinatura v2/v3 e
o alinhamento de 16 KB do pacote foram verificados. O hash da biblioteca
empacotada é idêntico ao da biblioteca fornecida.

## O que a evidência permite

No `classes.dex` do APK fornecido, `TVCore.getInstance()` em **0x700f60** chama
`initialise()J` e conserva o handle. `TVService$TVServer.run()` em **0x701028**
configura a porta do player **8902**, a porta de serviço **0** e o modo **1**;
depois chama `init(Context)` e, quando retorna 0, `run()`.

As declarações privadas com handle para `init`, `run`, `setAuthUrl`, `setUsername`,
`setPassword`, `setMKBroker`, `setOption`, `setListener`, `start`, `start2`, `stop`
e `quit` correspondem aos exports reais do ELF. A facade usa essas funções e os
seis callbacks de `TVListener`, em vez de executar `NativeUtil.classesInit0()` ou
carregar o login protegido do aplicativo original.

O ELF contém o formato de saída local
`http://127.0.0.1:%d/%u/main.m3u8`, no offset **0x7522a**. A ponte só anuncia uma
URL de reprodução depois que o callback nativo `onPrepared` entrega uma URL
desse formato na porta configurada. Não há vídeo, catálogo ou resultado de
engine simulado no componente.

## Contrato interno preparado

O serviço de controle escuta somente `127.0.0.1:62731` **dentro do Android**.
Ele exige o header `X-Bridge-Key`, cuja chave de pelo menos 32 bytes deve existir
no arquivo privado `files/bridge-key` do pacote. Sem esse arquivo o serviço encerra.
Não existe chave, usuário, senha, token ou endpoint de conta embutido no APK.

| Operação | Conteúdo |
| --- | --- |
| `GET /status` | Estado da ponte, evento, porta e URL local preparada |
| `POST /configure` | `engine: "tvbus"`, `authUrl`, `username`, `password`, `broker` opcional, `playPort` opcional, `options` opcional |
| `POST /start` | URI real do stream em `uri`, e `option` opcional para `start2` |
| `POST /stop` | Interrompe a reprodução |
| `POST /close` | Encerra a sessão da engine |

`/configure` é o ponto que carrega/inicializa a biblioteca e entra no loop da
engine. Receber uma configuração válida no Java não demonstra autorização do
stream pelo serviço remoto. O componente não registra pedidos, credenciais,
payloads de callback ou URIs em logs.

## Ambiente disponível e ativação posterior

Foram encontrados ADB **37.0.1**, emulator **37.1.11**, Java **21 ARM64**, Android
API **36** para compilação e uma imagem ARM64 Android **37.1**, com páginas de
16 KB. A consulta de versão do emulator falhou com NEON dentro do sandbox, mas
funcionou fora dele; somente versão/ajuda foram executadas. Os segmentos `PT_LOAD`
de `libtvcore.so` e `libgojni.so` estão alinhados a 16 KB, e as dependências do
TVCore são bibliotecas de plataforma Android.

Para uma etapa de execução, preparar um AVD novo com dados vazios em
`native-bridge/runtime/avd`, com `ANDROID_AVD_HOME` apontando para esse diretório e
`ANDROID_USER_HOME` também isolado. A imagem de sistema instalada pode ser lida
diretamente; os arquivos de userdata, snapshots, contas e configurações de
`Medium_Phone` ou `Codex_Ads_QA` não devem ser reutilizados. Usar outro servidor
ADB, por exemplo a porta 5038, e uma porta exclusiva de emulator, como 5580.

O emulator instalado documenta `-gpu swiftshader` para renderização em software;
a execução headless usa `-no-window`, `-no-audio` e `-no-snapshot`. Após instalar
apenas o APK próprio nesse AVD, preparar a chave privada do pacote e iniciar
explicitamente seu serviço foreground. Encaminhar as portas 62731 e 8902 pelo
ADB desse dispositivo isolado. O backend Node pode consumir a ponte e servir a
playlist/segmentos ao navegador pela sessão autenticada atual.

O emulador isolado e o APK original foram preparados pelo agente principal em
uma etapa separada. O teste da ponte identificou a restrição de certificação
descrita no início deste documento; configurar um AVD ou repetir o login não
remove essa restrição.

## Diagnóstico e cliente Node

O APK recompilado inclui apenas os valores numéricos `auth`, `tvcore`,
`extra_errno`, `errno`, `peers`, `initReturn` e `runReturn` no diagnóstico.
Campos de callback com strings estritamente numéricas também são aceitos.
`callbackShapes` descreve nomes e tipos de campos, nunca valores textuais.
Uma exceção expõe somente o nome de sua classe. A inicialização não é declarada bem-sucedida quando seus
campos estão ausentes ou negativos; uma falha de reprodução conserva o `errno`.
Após interromper a reprodução, um callback preparado atrasado não reativa a URL.

`lib/native-bridge.mjs` fornece o controle privado da ponte. Ele aceita somente
o endereço de controle loopback, não segue redirecionamentos e nunca inclui a
chave da ponte em pedidos de mídia. O endereço HLS precisa ter sido entregue
pelo callback real e pertencer à porta configurada e ao diretório numérico do
stream ativo. O servidor web deve encaminhar esses pedidos usando
`fetchMedia()` e validar os links de playlists usando `acceptsMediaURL()`.
Não é necessário nem adequado habilitar destinos de rede privada globalmente.

A engine atende uma reprodução por vez; o integrador precisa reservar seu uso
para a sessão autenticada que a configurou, liberando-o ao interromper/sair.
O contrato da engine usa `service.auth_url_sdk` e o usuário normalizado do APK
(sufixo `@wareztv.io` quando o usuário não contém `@`). Não utiliza o endpoint de
login HTTP como substituto da URL de autenticação do SDK.

## Limites que permanecem

- JNI, callbacks e autenticação da engine foram executados. A SDK rejeita a
  assinatura própria antes de preparar a reprodução; peers e HLS não foram
  comprovados. É necessária uma SDK/configuração autorizada pelo fornecedor
  para a assinatura do ARKHEN, ou outra interface oficial de reprodução.
- O método protegido `setAuthItems` não tem export JNI direto no TVCore ELF e
  não é usado pelo caminho `Spark.X0` recuperado. Nenhum mapeamento de
  `peer_id`, `user_id` ou `session_key` para opções foi inventado.
- O tipo de engine escolhido pelo serviço autenticado não foi informado a esta
  investigação. Este APK preparado implementa **TVBus**. **BinStream** usa
  `Libtvcar` e o runtime Java `go.Seq`; foi inventariado, mas ainda não foi
  implementado neste wrapper.
- Usar a saída HTTP local do APK original intacto, depois da seleção pela UI,
  permanece uma alternativa a validar. Não há controle externo de seleção de
  canal comprovado e o serviço original não é exportado.
- Nenhum pacote ou biblioteca do usuário foi modificado. Nenhuma conta foi
  transferida para outro serviço nesta preparação.
