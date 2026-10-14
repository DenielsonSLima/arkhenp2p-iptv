# Protótipo de depuração da engine original

Usa o APK **WPLAYP2P 11.9.0d intacto**, já autenticado em um AVD isolado.
Chama `TVCore.start(String)` e `stop()` da instância existente e observa o
`TVListener` existente com passthrough. Nenhum campo de autenticação, certificado,
resposta de validação, listener ou retorno de função é substituído. O wrapper de
observação sempre invoca o método original com os mesmos argumentos.

O attach/status foi validado no AVD isolado com Frida 17.8.0 e
frida-java-bridge 7.0.13. TV Brasil Central e SBT SP entregaram playlists HTTP 200
e segmentos MPEG-TS reais no teste de engine; a correspondência visual e o
fluxo pelo navegador têm validação própria. O login continua sendo processado
pelo próprio APK.

## Pré-condições

- AVD ARM64 de depuração/root isolado, com o APK original instalado e autenticado.
- `TVCore.inst`, `nativeHandle` e `tvListener` já existentes. O agent falha se não
  estiverem prontos, sem criar outra engine ou iniciar serviços.
- Frida cliente e servidor compatíveis, da mesma versão, instalados explicitamente
  pelo operador. O cliente só se conecta a `127.0.0.1:PORT` já encaminhado por ADB.
- Agent compilado localmente com `frida-java-bridge` (Frida 17 não injeta a ponte
  Java automaticamente nos scripts carregados pela API Python).
- A UI do APK deve ficar estável durante o teste; uma troca externa de canal ou
  parada invalida imediatamente a associação e o endereço retornado.

O transporte `client.py` e seus agentes não instalam APK/Frida, não ativam root,
não alteram SELinux, não abrem portas, não iniciam processos Android e não
reautenticam a conta. O iniciador opcional abaixo prepara somente os componentes
locais previamente instalados.

## Comando único neste Mac

Encerre a instância anterior do servidor ARKHEN e execute na raiz do projeto:

```sh
npm run start:p2p
```

No Finder, abrir `Iniciar ARKEHN.command` executa esse mesmo comando. A janela
do terminal deve permanecer aberta durante o uso. Para iniciar apenas o
servidor web sem preparar TV P2P, execute `npm start` manualmente.

O comando verifica ou inicia apenas o AVD `Arkhen_Engine_Debug`, porta 5582,
usando os dados isolados em `native-bridge/debug-runtime/avd` e o servidor ADB
local 5038. Ele reutiliza o emulador, o Frida 17.8.0 e o APK original quando já
estão abertos. Caso necessário, inicia o emulador sem janela, ativa o adbd root
desse AVD de depuração, abre o Frida já instalado e inicia a atividade principal
do WPLAY. Não instala nem baixa componentes, não altera o APK, não desliga
outros emuladores e não substitui encaminhamentos existentes de outro processo.

Os encaminhamentos locais são 27043 → Android 27042 (Frida) e 8904 → Android
8902 (HLS). O Frida Android escuta somente `127.0.0.1:27042`; ADB usa
`127.0.0.1:5038`; o servidor web escuta somente `127.0.0.1:4173`. Portas em
conflito e outra instância do iniciador geram erro explícito.

Antes de abrir o servidor, `readiness.py` faz attach somente para ler a versão,
o AuthInfo aceito e a presença da engine original; retorna apenas booleans.
Esse probe não instala hooks, não solicita senha e não reautentica. Se não houver
login salvo válido, abra o AVD `Arkhen_Engine_Debug` no Android Studio, entre
normalmente no WPLAY e execute o comando novamente. O login do navegador ainda
precisa ser da mesma conta; o adapter confere isso em cada sessão.

O iniciador aguarda até 45 segundos pela restauração da sessão e até dois
minutos pelo boot do AVD. Esses são limites máximos; o processo continua assim
que cada etapa estiver pronta. Ctrl+C encerra somente o servidor que ele criou,
aguardando a limpeza das reproduções. Frida e emulador permanecem abertos.
A remoção final da ponte Java pode provocar uma queda nativa do APK neste
runtime de depuração; a próxima execução reabre o APK quando necessário e
reutiliza a sessão salva, sem reenviar credenciais pelo iniciador.

Arquivos principais: `tools/start-p2p.mjs` (orquestração/servidor),
`tools/p2p-runtime.mjs` (verificações e componentes) e `readiness.py` /
`readiness-agent.mjs` (leitura da sessão). O bundle de readiness pode ser
recriado com `npm run build:readiness` nesta pasta, usando as dependências locais.
Os nove testes de `tests/p2p-runtime.test.mjs` usam comandos sintéticos e não
iniciam emuladores ou transmissões.

## Compilação e transporte

Dentro desta pasta, `npm install` e `npm run build` geram `agent.bundle.js`.
As dependências são locais e o bundle não contém dados de conta.

Execute `python3 client.py --endpoint 127.0.0.1:PORT` num processo controlado pelo
servidor local. Entrada e saída são JSONL por pipe. Não copie stdout para logs.

Operações:

- `{"op":"status"}`: estado, geração, requestId e diagnósticos numéricos; sem URL.
- `{"op":"start","requestId":"opaque-id","uri":"tvbus://...","timeoutMs":30000}`:
  recebe a URI real por stdin, para a sessão anterior e confirma a parada, depois
  chama `start` e aguarda `onStart` e `onPrepared`. Retorna somente HLS local
  validado em `http://127.0.0.1:8902/<channelId>/main.m3u8` ou `index.m3u8`.
- `{"op":"stop","requestId":"opaque-id"}`: para apenas a operação que ainda
  pertence a esse ID.
- `{"op":"detach"}`: para a operação ainda pertencente ao cliente e remove os
  observadores. EOF também encerra apenas a operação do cliente, restaura os
  métodos Java originais e remove o observador nativo antes de descarregar o
  script. O transporte aguarda essa saída; SIGINT só é usado se não concluir
  dentro de 6,5 segundos, com SIGKILL do cliente Python como último limite.

Erros e mensagens do Frida são filtrados; exceções, payloads de callback e
credenciais não são enviados para logs. O único endereço na saída protocolar é
o HLS local de uma operação bem-sucedida. URI TVBus nunca é retornada.

## Identidade e limites

`identity: serialized-start-callback` expressa a evidência efetiva: `stop` foi
confirmado, uma URI foi passada para a instância original e o callback posterior
liberou o HLS. Isso ainda exige teste com **dois canais distintos**, confirmando
que a imagem reproduzida corresponde a cada seleção. Não é uma confirmação
independente do título pelo SDK. O callback não retorna o ID do catálogo.

O `channelId` do HLS é o inteiro interno da engine (32 bits), não necessariamente
o ID longo do catálogo. Nunca inferir um a partir do outro. `/mpegts_live` é uma
saída genérica do canal corrente e não pode ser associada permanentemente a todos
os cards. Só HLS com diretório numérico é aceito por este protótipo.

Uma engine equivale a uma reprodução ativa. O integrador deve aplicar exclusão
por sessão, invalidar mídia ao trocar canal/encerrar sessão e limitar o proxy ao
diretório HLS ativo. Este transporte não implementa autenticação HTTP nem proxy.

O APK não emite `onStop` quando já está ocioso. Nesse caso, o observador nativo
confirma um novo ciclo de processamento após o comando, em estado `ready` ou
`failed`, sem canal pendente. Essa leitura exige ARM64 e o build-id/prológo
exatos da biblioteca original; outra versão falha explicitamente. Ela não
altera estado, retorno, autenticação ou certificação da engine.

`STOP_FENCE_TIMEOUT` continua sendo falha deliberada quando nem o callback nem
a leitura nativa confirmam a parada. Uma UI que inicie outro vídeo durante a
operação gera `EXTERNAL_CHANNEL_CHANGE`.

## Evidência e documentação

O adaptador opcional lib/original-engine-bridge.mjs implementa o contrato de
NativeBridgeManager. Construção: new OriginalEngineBridge({ endpoint:
'127.0.0.1:27043', mediaPort: 8904 }). O transporte privado
lib/original-engine-rpc.mjs inicia apenas o cliente Python local por pipes.
A seleção no servidor exige ativação explícita; não há inicialização automática
do APK, ADB ou Frida.

## Ativação no servidor local

Pré-condições: o APK original está aberto e autenticado na mesma conta do
navegador, o cliente/servidor Frida está preparado no AVD isolado e os
encaminhamentos locais estão ativos: 27043 para Frida e 8904 para a porta de
mídia Android 8902. O bundle e o ambiente Python local devem estar prontos.
Nenhuma dessas operações é executada pelo servidor web.

Depois de encerrar a instância anterior do servidor, execute na raiz do projeto:

```sh
ARKHEN_ORIGINAL_ENGINE=1 \
ARKHEN_ORIGINAL_ENGINE_ENDPOINT=127.0.0.1:27043 \
ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT=8904 \
npm start
```

Apenas `ARKHEN_ORIGINAL_ENGINE=1` ativa essa opção. Os demais valores mostrados
são os padrões. O endpoint precisa ser 127.0.0.1 e as portas devem ser distintas,
entre 1024 e 65535. Uma configuração inválida impede a inicialização, sem
selecionar outra engine silenciosamente. Esse modo tem prioridade sobre a chave
da ponte anterior. Variáveis de ambiente não contêm usuário, senha ou token.

O servidor abre o cliente Python somente na primeira reprodução P2P e compara
a conta autenticada no APK antes de liberar mídia. Filmes e episódios HTTP
continuam usando a fonte de catálogo. A engine comporta uma reprodução por vez;
outra sessão do navegador recebe erro de ocupado enquanto ela está em uso.

Fechar o player interrompe a reprodução da sessão. Sair da conta também revoga
todas as fontes e apaga a conta esperada do adaptador. A conexão de controle
permanece aberta durante a vida do servidor: a nova sessão precisa verificar
novamente a conta aceita pelo APK e não herda nenhuma permissão de mídia.
Para encerrar o servidor, use Ctrl+C no seu terminal ou envie
SIGTERM ao PID dessa instância. O processo aguarda logout e limpeza dos clientes
antes de concluir o encerramento e descarrega a ponte somente nessa etapa.
Ele não envia comandos para encerrar o APK, Frida ou o emulador. No runtime atual,
o descarregamento do Java bridge pode derrubar o APK; `start:p2p` o reabre.

Para executar sem esse adaptador, encerre a instância e use:

```sh
ARKHEN_ORIGINAL_ENGINE=0 npm start
```

O valor 0 desativa o adaptador do APK original; a configuração legada da ponte,
se existir em .local/native-bridge-key, mantém seu comportamento anterior.
Arquivos .env não são carregados automaticamente por npm start.

## Conta e mídia

configure apenas anexa e verifica a conta já autenticada; não envia senha ou
URL de autenticação ao cliente. O RPC verifyAccount recebe o usuário esperado e
retorna somente boolean, lendo por reflexão o AuthInfo aceito em td.m.d.
O encaminhamento ADB 8904 → Android 8902 deve estar pronto. start traduz o HLS
validado para a porta local 8904. O proxy aceita somente os caminhos comprovados
main/index/cdn-dl-segment.m3u8 e hls-seg-N.ts no diretório atual, sem
redirecionamentos ou headers de credenciais. Manifests com URLs absolutas para
a porta Android 8902 precisam de evidência e tratamento explícito.

Cada leitura de mídia confere a operação e a conta atual; uma checagem periódica
também revoga streams abertos em caso de troca externa. Cancelamento durante
startup revoga a resposta para o navegador imediatamente, mas drena a operação
pendente no pipe antes de consultar e parar o ID ainda pertencente à sessão.
A seleção seguinte aguarda essa parada e reutiliza a ponte, sem reenviar login.
Uma preparação inválida mantém o ID
opaco da operação para que o cleanup consiga parar a engine.

Testes locais: 14 do agente/observador, 9 do cliente Python e 12 do adaptador/transporte.
Incluem troca A → B durante o carregamento, revogação, isolamento de sessão,
interrupção de mídia, redirecionamentos e ausência de credenciais nos headers.

Contrato Java: `classes.dex`, `com.tvbus.engine.TVCore`, métodos `getInstance()`,
`start(String)`, `start(String,String)`, `stop()`, `stop(int)` e os seis callbacks
`TVListener(String)`. Os campos privados são lidos só para encontrar instância e
listener já existentes; nenhum valor é escrito.

- [Frida no Android](https://frida.re/docs/android/)
- [Frida JavaScript API](https://frida.re/docs/javascript-api/)
- [Mudança das pontes na versão 17](https://frida.re/news/2025/05/17/frida-17-0-0-released/)
- [Depuração Android Studio](https://developer.android.com/studio/debug)
