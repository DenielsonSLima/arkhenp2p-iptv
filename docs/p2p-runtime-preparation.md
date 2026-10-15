# Preparação do runtime P2P por plataforma

Este documento registra o experimento opcional com o APK. O aplicativo padrão inicia com `npm start` e integra a reprodução do player web WPLAY. A preparação Android foi interrompida após a confirmação desse fluxo pelo usuário; nenhum AVD foi iniciado. Os arquivos e o WHPX preparados durante a investigação permanecem registrados abaixo, sem reinicialização do computador.

O iniciador e o transporte Node/Python agora resolvem caminhos próprios de Windows, macOS e Linux. Isso não confirma a execução do APK ou dos observadores nativos nesses sistemas: a prova anterior veio de um AVD ARM64 em outro Mac, que não está neste workspace. A engine continua no aplicativo original intacto, com a sessão do próprio APK; configurar Supabase ou fazer login no navegador não inicia essa engine.

## Diagnóstico sem instalação

```sh
npm run check:p2p -- --json
```

O comando retorna JSON com arquitetura, CPU/RAM/disco, virtualização observável, componentes encontrados, hash do APK e plano de preparação. Não instala pacotes, cria diretórios, inicia ADB/emulador/aplicativo, lê contas, aceita licenças ou altera o Windows. Se CIM for negado, a virtualização fica `unknown`; a ausência de permissão não vira “virtualização desativada”. Código de saída 2 indica componentes ausentes; 1 indica falha/configuração inválida.

Quando os executáveis já tiverem sido preparados, a opção abaixo também consulta a versão de Java/Frida e `emulator -accel-check`, com argumentos fixos, limites de tempo e ambiente sem chaves do servidor. Esse diagnóstico não inicializa um AVD. Não se deve executar binários de origem desconhecida apenas para preencher o diagnóstico.

```sh
npm run check:p2p -- --json --probe-tools
```

`components-present-engine-unverified` significa arquivos presentes. Nunca significa vídeo comprovado. Erros de ferramentas retornam somente códigos/estados; stdout, stderr, ambiente completo e dados de conta não entram no relatório.

## Estado desta máquina em 15/10/2026

A medição inicial de hardware foi feita aproximadamente às 14:03 UTC. A preparação posterior foi autorizada pelo usuário com a condição de não reiniciar. Os resultados privados registram as etapas efetivamente executadas.

| Verificação | Resultado observado |
| --- | --- |
| Sistema/CPU | Windows 11 Home Single Language, build 26200, x64; Intel Core i3-1315U |
| Memória | Aproximadamente 8 GB instalados; 7,7 GiB visíveis e menos de 1 GiB disponível durante a verificação |
| Disco do workspace | Aproximadamente 123 GiB disponíveis |
| Hipervisor | `HypervisorPresent=true` |
| Windows Hypervisor Platform/WHPX | Inicialmente desativado; ativado após autorização, com `RestartRequired=true`, sem reinicialização |
| Virtual Machine Platform | Recurso desativado, `InstallState=2` |
| Java e Android Command-line Tools | JDK 21.0.12.1+1 e ferramentas 22.0 preparados no workspace após validação SHA-256; Java respondeu à consulta real de versão |
| SDK/ADB/emulador/imagem/AVD | Platform Tools 37.0.1, Emulator 37.2.12 e Google APIs Android 11/API 30 x86_64 revisão 16 preparados com checksum oficial; criação/boot do AVD ficam sob preparação separada |
| Python privado/Frida | Preparados pelo agente responsável em `python-base` e `python`; aliases Microsoft Store não são usados |
| Bundles dos observadores | Compilados localmente nesta etapa: `agent.bundle.js` 736.923 bytes e `readiness-agent.bundle.js` 716.144 bytes; lockfile preservado |
| APK recebido | SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`, igual ao APK 11.9.0d já inspecionado; bibliotecas ARM64/ARMv7 |

Com um hipervisor ativo, flags de virtualização do processador podem ficar mascaradas. O diagnóstico não conclui que o BIOS está desativado a partir desses flags. `InstallState=2` significa desativado segundo a [documentação CIM da Microsoft](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-optionalfeature).

O arquivo privado `.local/p2p-preflight.json` registra o resultado desta execução. Ele está ignorado pelo Git. O orçamento proposto de 16 GiB de disco e 16 GiB de RAM é uma margem de planejamento, não uma medição de download nem uma garantia de funcionamento. A máquina atual exige verificar o consumo real antes de executar Android junto com navegador/servidor.

## Manifesto Windows x64 pesquisado

O manifesto público [`tools/p2p-install-artifacts.json`](../tools/p2p-install-artifacts.json) fixa oito artefatos Windows x64, URLs oficiais, tamanhos e checksums, sem caminhos desta máquina. [`tools/p2p-install-plan.mjs`](../tools/p2p-install-plan.mjs) calcula destinos a partir do workspace corrente; um clone funciona sem plano privado. O plano privado [`.local/p2p-install-plan.json`](../.local/p2p-install-plan.json) guarda a pesquisa detalhada desta preparação. A soma comprimida é aproximadamente **2,20 GiB**, sem contar expansão/AVD. Após a autorização, os downloads e a preparação foram iniciados; os resultados verificáveis são gravados em `.local`.

| Componente | Versão fixada | Download comprimido |
| --- | --- | --- |
| Temurin JDK ZIP Windows x64 | 21.0.12.1+1 | 195,6 MiB |
| CPython instalador x64 | 3.13.16 | 28,5 MiB |
| Android Command-line Tools | 22.0, build 15859902 | 148,4 MiB |
| Android Platform Tools | 37.0.1 | 7,7 MiB |
| Android Emulator estável | 37.2.12 | 434,2 MiB |
| Google APIs Android 11 x86_64 | API 30, revisão 16 | 1.371,6 MiB |
| Wheel Frida Windows x64 | 17.8.0, cp37-abi3 | 40,0 MiB |
| Frida Android x86_64 | 17.8.0 | 30,2 MiB |

Java, CPython, Command-line Tools e Frida têm SHA-256 publicado. O XML Google fornece SHA-1 para imagem, emulador e Platform Tools; o manifesto identifica essa diferença, sem inventar um SHA-256 oficial. Calcular SHA-256 após um download futuro será um registro local, não prova adicional do publicador. [API oficial Adoptium](https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse), [CPython 3.13.16](https://www.python.org/downloads/release/python-31316/), [Android Tools](https://developer.android.com/studio), [metadados Google da imagem](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml), [wheel oficial Frida](https://pypi.org/project/frida/17.8.0/), [release Frida](https://github.com/frida/frida/releases/tag/17.8.0).

A base CPython escolhida é o instalador completo com `InstallAllUsers=0`, `TargetDir` privado e PATH, launcher, associações e atalhos desativados. Isso permite `venv`/pip, mas **não é extração puramente portátil**: pode registrar dados por usuário e usar cache fora do workspace. Sua preparação foi autorizada explicitamente. `/layout` apenas pré-baixa componentes; não entrega um interpretador instalado. A distribuição embutida omite pip e não suporta o uso normal de dependências geridas por pip. A alternativa oficial NuGet poderá evitar o instalador, mas ainda precisa de manifesto e validação própria de `venv`/`ensurepip`; não foi selecionada nem testada. [Documentação CPython Windows](https://docs.python.org/3.13/using/windows.html).

## Matriz de preparação

| Host | Imagem candidata isolada | Aceleração | Limite da conclusão |
| --- | --- | --- | --- |
| Windows x64 | Android 11/API 30 Google APIs x86_64, com tradução ARM64 | WHPX | Candidato de desenvolvimento; hooks/processo ARM64 ainda precisam de prova real |
| macOS Intel x64 | Android 11/API 30 Google APIs x86_64, com tradução ARM64 | Hypervisor.Framework | Mesma prova de tradução pendente |
| macOS Apple Silicon ARM64 | Imagem Google APIs arm64-v8a disponível para esse host | Hypervisor.Framework | Caminho nativo candidato; não reutilizar AVD/conta de outro Mac |
| Linux x64 | Android 11/API 30 Google APIs x86_64, com tradução ARM64 | KVM e permissões em `/dev/kvm` | Candidato; exigir distribuição oficial de ferramentas e prova real |
| Windows ARM64 / Linux ARM64 / outros | Não preparado por este plano | Não inferida | Caminhos JavaScript portáveis não comprovam uma distribuição oficial do emulador para esses hosts |

O planejador usa o identificador `system-images;android-30;google_apis;ABI`. Antes de baixar uma imagem, o preparador deve confirmar sua disponibilidade no repositório para o host. A documentação exige imagem compatível com a CPU para aceleração; Windows usa WHPX, macOS usa Hypervisor.Framework e Linux usa KVM. Ativar WHPX pode exigir reinicialização. [Aceleração oficial](https://developer.android.com/studio/run/emulator-acceleration).

As notas oficiais do Android 11 descrevem imagens x86_64 que incluem suporte ARM64/ARMv7. Isso não comprova que o `Process.arch`, build-id, prólogo, offsets e observadores específicos deste APK funcionem sob tradução. O guard de ABI anunciado pelo Android é somente uma condição necessária. Essa combinação deve falhar explicitamente se a identidade nativa não corresponder. [Notas do Android Emulator 30.0.0](https://developer.android.com/studio/releases/emulator#30-0-0).

## Plano automatizável e isolado

Os preparadores entregues baixam fontes fixadas no manifesto público e validam tamanho/checksum antes de extrair em staging privado. Os destinos são verificados dentro do workspace, inclusive para impedir escape por junction/symlink. Uma instalação existente diferente é preservada; recibos de mesma versão/hash permitem reutilização. Os scripts não iniciam Android nem alteram o PATH global.

```sh
# Planejar, sem baixar ou aceitar licenças:
npm run prepare:p2p:tools
npm run prepare:p2p:sdk

# Preparação explícita já autorizada para este ambiente local:
npm run prepare:p2p:tools -- --apply
npm run prepare:p2p:sdk -- --apply --accept-sdk-licenses
```

A opção `--accept-sdk-licenses` é falsa por padrão e obrigatória para aplicar o SDK. Ela aceita somente o ID `android-sdk-license` exigido pelos três pacotes fixados; termos de preview/fornecedores não selecionados recebem recusa. Em 15/10/2026, o SDK registrou o hash `24333f8a63b6825ea9c5514f83c2829b004d1fee`. IDs/hashes e instante ficam em `.local/p2p-sdk-license-acceptance.json`. Essa execução é para desenvolvimento local autorizado. A imagem API 30 revisão 16 referencia `uses-license ref="android-sdk-license"` no XML oficial; isso não autoriza aceitar automaticamente outra licença no futuro. SDKManager real confirmou as versões publicadas antes dos downloads.

1. Preparar `native-bridge/debug-runtime/android-sdk`, `jdk`, `python-base`, `python`, `avd` e `android-user`, com arquivos privados ignorados pelo Git. Não copiar AVDs globais, userdata, contas ou snapshots existentes.
2. Usar JDK 21 portátil como escolha deste plano, sem instalação global ou mudança permanente de `JAVA_HOME`/PATH. Ele serve à preparação pelo SDK; não é necessário recompilar, reassinar ou modificar o APK original.
3. Colocar Android Command-line Tools em `android-sdk/cmdline-tools/latest`. Após a revisão/aceite explícito das licenças aplicáveis, preparar `platform-tools`, `emulator` e a imagem selecionada pelo host. A [documentação do sdkmanager](https://developer.android.com/tools/sdkmanager) define pacotes e `--sdk_root`; o instalador não deve responder “yes” automaticamente às licenças.
4. Preparar Python 3 e um ambiente privado com Frida **17.8.0**, versão exata exigida pelo código existente. Windows espera `python/Scripts/python.exe`; macOS/Linux esperam `python/bin/python3`. Um ZIP Python embutido sem pip/venv não deve ser confundido com ambiente pronto. A instalação base deve ficar no workspace ou ser selecionada explicitamente pelo operador. [Requisitos oficiais do Frida](https://frida.re/docs/installation/).
5. Gerar os bundles JavaScript a partir do lockfile de `tools/original-engine`, sem iniciar Android. Os comandos abaixo são a etapa local de build revisável; o checker não os executa:

   ```sh
   npm --prefix tools/original-engine ci
   npm --prefix tools/original-engine run build
   npm --prefix tools/original-engine run build:readiness
   ```

6. Rodar novamente o preflight e a verificação de aceleração. Se WHPX estiver desativado, parar nessa etapa para a mudança de sistema ser tratada separadamente; não ativar recursos nem reiniciar automaticamente.
7. Criar somente `Arkhen_Engine_Debug` no diretório privado, usando ADB isolado na porta 5038 e serial `emulator-5582`. Confirmar root de depuração dessa imagem antes de instalar o servidor Frida; imagens Play Store de produção não devem ser tratadas como root.
8. Usar o Frida Android da mesma versão e ABI do sistema convidado: **android-x86_64** para imagem x86_64; **android-arm64** para convidado ARM64. Suporte de APK ARM64 traduzido não torna o servidor Frida do sistema x86_64 um binário ARM64.
9. Verificar hash/versão do APK intacto, instalar apenas nesse ambiente isolado e permitir login pelo aplicativo genuíno. Não importar ou extrair a sessão de outro dispositivo.
10. Provar a engine, callbacks, playlist, segmentos e vídeo no navegador com a mesma conta antes de habilitar TV P2P nesse host. Presença de arquivos e testes sintéticos não substituem essa prova.

O mínimo que pode ser preparado exclusivamente no workspace é o checker, o manifesto/plano, a resolução de caminhos, os bundles e os runtimes portáteis com downloads verificados. Bundles não exigem emulação/Java/conta. Os preparadores reutilizam arquivos completos já verificados e recibos de preparação, sem tocar no servidor Node já aberto; ativar aceleração do Windows e ligar a engine são etapas distintas. Downloads do SDK usam streams; as extrações são serializadas para limitar a memória e os comandos Java usam `-Xmx512m`.

O diagnóstico real posterior à ativação do recurso, sem reinicialização, retornou `WHPX(10.0.26200) is installed and usable.` e código 0. A prova está em `.local/p2p-acceleration-check.json`; ela não iniciou AVD nem comprovou a engine. `RestartRequired=true` do Windows e esse teste de capacidade atual são resultados distintos, mantidos no registro.

## Android externo como transporte opcional

Um Android ARM64 externo autorizado elimina a necessidade de imagem/emulador, aceleração do host e JDK para criação de AVD. O transporte existente `OriginalEngineBridge`/`OriginalEngineRPC` aceita o endpoint Frida e a mídia somente em loopback; encaminhamentos USB/ADB explícitos podem chegar ao dispositivo. A validação de mesma conta continua obrigatória. O iniciador `start:p2p` atual seleciona apenas o AVD isolado e não escolhe nem modifica um telefone automaticamente.

O observador atual exige Frida/root ou ambiente de depuração previamente preparado para anexar ao aplicativo original, além de ARM64 e identidade nativa compatível. Um telefone comum sem root não é suportado automaticamente. Não foi implementada uma engine externa genérica que dispense essas condições, e a ponte APK própria anterior teve rejeição de certificação. Esse caminho precisa de prova real e preparação explícita do dispositivo; nenhuma instrução deste plano faz root, remove verificação de certificado ou altera a autenticação.

## Limite de licença da tradução ARM

A licença específica `android-sdk-arm-dbt-license`, seção 4.7, limita a execução traduzida ARM a desenvolvimento e depuração. Ela foi recusada nesta seleção, pois a imagem API 30 revisão 16 referencia `android-sdk-license`; somente esse ID foi aceito com a opção explícita. Os termos gerais também limitam o SDK ao desenvolvimento Android. O plano x86_64 é um caminho de desenvolvimento e não deve ser tratado como licença de engine universal redistribuível/comercial para clientes. O checker nunca aceita licenças; o preparador SDK exige a opção separada descrita acima. [Termos no repositório oficial Google](https://android.googlesource.com/platform/prebuilts/android-emulator-build/system-images/+/dd5fdd791f3894ff0b8fdd0095a7890a2235ed77%5E%21/), [termos gerais do SDK](https://developer.android.com/studio/terms).

## Verificação

`tests/p2p-preflight.test.mjs` cobre ausência de componentes sem iniciar processos, correspondência de hash, plano por arquitetura, não inferir playback de arquivos presentes, isolamento de ambiente, flags de virtualização mascarados, falha de permissão como desconhecida e argumentos seguros de probes opcionais. `tests/p2p-preparation.test.mjs` cobre consentimento falso por padrão, recusa de licenças não selecionadas, checksum antes da extração, tamanhos HTTP com compressão de transferência, reutilização e extrações serializadas. Esses testes usam respostas/arquivos sintéticos. O relatório Windows, a consulta Java, o SDKManager `--list` e o diagnóstico de aceleração desta seção vieram de comandos reais. Android e reprodução não foram executados por estes preparadores.
