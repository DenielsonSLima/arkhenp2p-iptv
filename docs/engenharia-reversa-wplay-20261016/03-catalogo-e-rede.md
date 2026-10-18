# Catálogo, rede e trabalho em segundo plano do WPLAY

Data da análise: 16/17 de outubro de 2026. Método: inspeção estática do APK fornecido, sem executar aplicativo, mídia, emulador, serviços Android ou chamadas ao provedor.

## Artefato e nível de evidência

O alvo deste documento é `WPLAYP2P.apk`, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`, pacote `io.wareztv.android.one`, versão `11.9.0d`, versionCode `1190`. A identidade foi obtida novamente por REA e comparada com os bytes do ZIP. O inventário completo e reproduzível está em [metodos-primary.tsv](metodos-primary.tsv), [campos-primary.tsv](campos-primary.tsv) e [ferramentas/inventariar_dex.py](ferramentas/inventariar_dex.py).

Neste documento, **confirmado atual** significa corpo Java recuperado do APK acima ou estrutura DEX lida diretamente. **Histórico declarado** significa relatório anterior que declara esse SHA, mas cujo dump intermediário já não está disponível para repetição. **Não resolvido** significa que o APK atual expõe apenas método `native` e a extração atual não recuperou seu corpo. A existência de um símbolo não comprova que aquele caminho foi executado por uma conta real.

Os arquivos genéricos `analysis/metadata.json`, `analysis/AndroidManifest.xml`, `analysis/methods/` e as bibliotecas extraídas em `analysis/native/` pertencem a outra distribuição, `12.0.3`. Não foram usados como prova do corpo atual. Os relatórios específicos `WPLAYP2P-11.9.0d-*` são citados separadamente e com essa limitação. Todos os offsets abaixo são relativos ao membro DEX descomprimido, e não ao APK inteiro. `code_item = 0` em método `native` significa ausência de bytecode Java naquele DEX; não é endereço de código nativo.

## Caminho da inicialização até os pedidos

```mermaid
flowchart TD
  A[SpkApplication.onCreate] --> B[OkGo e cliente HTTP compartilhado]
  C[Spark.onCreate] --> D[Handler e ViewModels + views]
  D --> E[Spark.v: ACache, fragmentos e adapters]
  E --> F[Handler mensagem 7]
  F --> G[Spark.x: corpo native não recuperado]
  H[Handler mensagens 8, 11, 13] --> I[SparkViewModel.getUser().j]
  J[Handler mensagem 15] --> K[Spark.I: catálogo ao vivo]
  K --> L[utils.y caso 1]
  L --> M[Thread bugly.i0 caso 1: parse ChannelBean]
  M --> N[td.c.a: corpo native]
  M --> O[Handler mensagem 20]
  O --> P[Spark.K: arquivo EPG]
  O --> Q[Mensagem 19: Spark.L se VOD habilitado]
  K --> R[Mensagem 18 atrasada]
  R --> K
  P --> S[Mensagem 32 atrasada]
  S --> P
```

`SpkApplication.onCreate` liga `OkGo.init(this)`, o cliente criado por `utils.i0.h(...)`, `setCacheTime(h.f12948i)` e `setRetryCount(1)`. A configuração e suas lacunas estão detalhadas em [02-armazenamento.md](02-armazenamento.md). Isso é inicialização do cliente; não comprova uma requisição por si só.

`Spark.onCreate(Bundle)` cria ou reutiliza o Handler estático `e1` no Looper principal, atualiza sua `WeakReference<Spark>`, registra observadores do `SparkViewModel` e associa os componentes de tela. Depois chama `v()` caso o tipo de dispositivo já tenha sido escolhido; a escolha inicial termina por callbacks próprios. `v()` monta os fragmentos live/VOD/histórico/configurações, adapters, controles de mídia e o cache `ACache`. O `ViewPager` mantém `offscreenPageLimit = quantidade de páginas - 1`, portanto várias telas podem permanecer vivas mesmo sem estarem visíveis. Isso permite callbacks locais de tela; isoladamente não prova download contínuo.

Ao fim de `v()`, uma mensagem `7` chama `Spark.x()`, cujo corpo é nativo. Há chamadas visíveis a `getUser().j()` nas mensagens `8`, `11` e `13`, e a `getUser().h()` na `9`. O fechamento exato entre esses métodos, autenticação e emissão da mensagem `15` depende de corpos protegidos. Não se atribui à mensagem `7` uma sequência de rede que não está exposta no Java atual.

Na mensagem `15`, o Handler consulta `AuthInfo.service`, oculta menus conforme `enabledLive`/`enabledVoD`, chama `Spark.Z0()`, **chama `Spark.I()` diretamente**, inicializa funções de tela e prossegue. O Java não coloca essa chamada a `I()` dentro de um `if(enabledLive)`: esconder o menu e não baixar catálogo são comportamentos distintos. A mensagem `20`, emitida ao terminar o processamento live, chama `K()` e agenda `19` após `10 ms`; esta chama `L()` somente se o gate local `h.f12952m`, `AuthInfo.service` e `enabledVoD` permitirem. Não há um cron de nuvem nessa sequência.

## Pedido de autenticação e identidade

`td.m.e()` foi reextraído com corpo Java completo do alvo atual. Lê uma preferência de modo; se não vale `1` ou `2`, envia mensagem `10` e retorna. Caso permitido, monta 15 campos `HttpParams`:

| Grupo | Campos e origem visível |
|---|---|
| Operação e conta | `from="ap"`; `username` e `password` lidos de preferências. Valores de conta não foram consultados. |
| Identidade da instalação | `deviceID` pelo helper `ic.y.A(context)`; `packageName`, `appName`, `appVersion` pelos campos estáticos populados por `Spark.U()`. |
| Dispositivo | `buildBrand`, `buildProduct`, `buildBoard`, `buildABI`, `buildDisplay`, `buildModel` e `sysVersion` pelas propriedades Android `Build`. |
| Interface | `operateMode` por preferência inteira, com padrão `0`. |

Os nomes foram decodificados estaticamente das constantes atuais pelo XOR/Base64 de `ua.c.l`; não por envio de formulário. `Spark.U()` obtém o packageName do contexto, versionName/versionCode do PackageManager, nome do recurso `app_name`, modelo e identificador do helper, e formata `Apache-HttpClient/Null (%s %s; Android %s; %s; %s)` para o User-Agent. A origem detalhada do `deviceID` no helper não foi reaberta nesta rodada; o relatório histórico o identifica com `Settings.Secure.android_id` e fallback constante.

O builder escolhe `td.m.i(td.l.f16117b)`, alterna para `td.l.f16128n` se seu contador interno vale `1`, cancela pedidos anteriores com `OkGo.cancelTag(this)` e faz **POST**, User-Agent próprio, `params(HttpParams)`, mesmo tag, `NO_CACHE` e **`retryCount(0)`**. A escolha por pedido sobrescreve a configuração global de uma tentativa de retry; não se pode aplicar o retry global de OkGo ao login sem ler esse builder. Não há `upJson`/`upString` nessa construção. O relatório histórico seguiu a dependência OkGo e descreveu `application/x-www-form-urlencoded`; essa aresta interna da biblioteca não foi reextraída aqui.

Há um achado concreto de tratamento de dados no corpo atual: antes do POST, um `Log.i` concatena a URL selecionada, o usuário e a senha lidos das preferências. Isso demonstra capacidade de registrar credenciais sem máscara nesse ponto do código; não é uma coleta de logs reais nem prova de transmissão deles a um servidor. O corpo foi mantido privado e nenhum valor de conta foi incluído no dossiê. Esse log também não explica, sem evidência adicional, o volume de consultas de logs do Supabase.

Os seletores `td.m.i/d`, o tratamento de resposta `td.m.k` e parte dos callbacks permanecem protegidos. O relatório histórico descreve normalização de credenciais na UI, resposta JSON `AuthInfo`, sucesso por `AuthInfo.code == 0`, fallback de login separado de erros de conta e adição de token às URLs do serviço. Essas semânticas não são elevadas a prova de uma autenticação atual; HTTP 200 isolado tampouco certificaria sessão ou reprodução. As URLs concretas e tokens foram omitidos.

## Entregas recebidas do servidor

| Entrega | Chamada e processamento comprovados | Responsabilidade local e limites |
|---|---|---|
| Autenticação/configuração | Há `td.m.e()` Java e os seletores `td.m.i(td.l)`/normalizador `td.m.d(String)` nativos. | O relatório histórico de autenticação descreve `AuthInfo.service` com URLs de catálogo, EPG, VOD e token; a extração atual não reabriu esses corpos nativos. Nenhuma URL privada é reproduzida aqui. |
| Catálogo live | `Spark.I()` obtém uma URL de `td.m.i(td.l.f16120e)`, faz `OkGo.get`, define User-Agent pelo campo `a.f12830m`, aplica `tag(td.c)` e `NO_CACHE`. | A resposta inteira é convertida por `JSON.parseArray(..., ChannelBean.class)` em thread e atribuída a `td.c.f16086b`. `td.c.a()` é a etapa nativa seguinte; a montagem completa dos grupos não foi recuperada agora. |
| Categorias VOD | `Spark.L()` obtém `td.m.i(td.l.f16123i)`, faz GET com mesmo padrão de User-Agent/tag/`NO_CACHE`; `utils.y` caso 2 faz `JSON.parseArray(..., GroupBeanModel.class)`. | Ordena grupos e seus `items`, chama `td.o.a()` e envia mensagem `22` em `finally`. Categorias chegam do servidor; não são derivadas da lista live. |
| Página de itens VOD | `ae.t2.o0(int,String)` escolhe URL do item de categoria retornado, aplica `td.m.d`, consulta um cache local por categoria e chama `r0(url,category,page,false)` se não houver lista. | O estado inicial visível é página `1`; o método `r0` é nativo no DEX atual. O relatório histórico descreve GET paginado e resposta `ChannelBean[]`; não se certifica aqui sua execução nem todos os disparadores de scroll. |
| Detalhe VOD | O DEX contém `sd.a1.onClick`, `ae.l2.c` e os modelos relacionados. | O relatório histórico descreve seleção de endpoint SEARCH, sufixo do `chid` e resposta de um único `ChannelBean` com fontes; esse contrato não foi reextraído integralmente nesta rodada. |
| Grade EPG | `Spark.K()` faz download de um único arquivo e `td.e` inicia a thread `td.f`. | Parser protegido recebe arquivo e limites de tempo; consumo e atualização visual são locais. Ver [04-epg-e-atualizacao.md](04-epg-e-atualizacao.md). |

No modelo `ChannelBean` do alvo, são visíveis `chid`, identificador textual, nome, logo/imagens, descrição, classificação, ano, fontes, tags, EPG, `epgSameAs`, `hasPlayBack` e dados de temporadas. O mesmo modelo atende itens com comportamentos diferentes. A presença de `seasonSourcesMap` e `seasonCount` não autoriza classificar todo item como série. O relatório histórico registra extração de temporada/episódio do nome da fonte; isso não é evidência de um endpoint separado obrigatório por episódio.

As fontes são objetos do catálogo. O relatório histórico específico descreve `getDefaultUrl` retornando o endereço da fonte selecionada; a inspeção REA do mesmo SHA apenas confirmou a existência do método protegido, sem corpo Java (`ev_550b799fcb044f8a6101b5b191664a2b3fd68f1c4faced7e2e1d0c3bffd231fd`). Não há base para converter automaticamente um endereço P2P em HLS, deduzir um formato universal de endpoint ou criar uma nova origem de mídia. Entrega de catálogo e abertura da fonte são contratos diferentes; a reprodução está em [05-reproducao-e-memoria.md](05-reproducao-e-memoria.md).

## Cache, falha e repetição do catálogo

`NO_CACHE` é a opção do pedido OkGo observado, mas **não significa ausência de cache manual**. Em `utils.y.onSuccess`, caso `1`, a aplicação inicia o parse e grava a resposta bruta por uma thread `rd.a` no `ACache`, com prefixo produzido por `xc.a.z(h.f12948i / 1000)`. A remoção da chave anterior e a gravação estão separadas da thread de parse. Não se observou uma transação única ligando arquivo em disco e publicação em RAM.

`utils.y.onError`, caso `1`, tenta ler esse arquivo, verifica o prefixo por `xc.a.O/M`, remove entrada vencida e, se recupera um corpo, encaminha-o à mesma thread de parse. Sem corpo utilizável, substitui a lista por `new ArrayList()`, chama `td.c.a()`, sinaliza erro e envia `20`, permitindo que a inicialização prossiga para EPG/VOD. A decompilação desse método contém avisos de inferência e uma estrutura de loop pouco legível: serve para comprovar leitura/fallback e chamadas explícitas, não para afirmar um loop infinito no aplicativo real.

`utils.y.onCacheSuccess` também encaminha o caso `1` à thread de parse, mas os pedidos atuais de `Spark.I()` escolhem `NO_CACHE`. A mera existência desse callback não prova que OkGo o usa nesse caminho. O cache manual é comprovado por chamadas próprias.

O parse live está no caso `1` de `com.tencent.bugly.proguard.i0.run`. O caso `0` da mesma classe contém trabalho de relatórios de falha do Bugly. O nome do pacote não torna o parse de catálogo um envio de crash: o discriminador passado ao construtor é que seleciona o comportamento. O `finally` do caso live envia `20` inclusive após exceção de parse.

## Periodicidade e ociosidade

| Trabalho | Gatilho visível | Rearme visível | O que esta análise não mede |
|---|---|---|---|
| Catálogo live | Mensagem `15`; mensagem `18` | Ao final de `I()`, só agenda `18` se `h.f12946g > 0`. O inicializador atual atribui **-1**, portanto esse caminho não rearma no valor inicial do APK. | Total de pedidos durante horas reais de uso e chamadas originadas em corpos protegidos. |
| EPG | Mensagem `20`; mensagem `32` | `K()` remove mensagens `32` pendentes e agenda uma com `h.f12947h`, inicialmente **1800000 ms / 30 minutos**, se o gate `h.f12951l` permite a rotina. | Duração do download, sobreposição de requisições em voo e intervenção de JNI/reflexão. |
| Categorias VOD | Mensagem `19`, após processamento live | Não há rearme próprio em `L()` | Outros disparadores em métodos protegidos. Repetição do ciclo live pode voltar a percorrer `20 → 19`. |
| Itens de categoria VOD | `ae.t2.o0`, sem lista no cache daquela categoria | Estado de página local e `r0` protegido | Cadência completa de paginação/prefetch. |
| EPG de um canal/dia | Seleção e renderização local | Cache/mapas em RAM | Não foi visto pedido HTTP por célula, canal ou minuto no Java analisado. |

Os valores foram decodificados diretamente do bytecode de `h.<clinit>`, classes2.dex `code_item 0x19e69c`: catálogo `-1` na atribuição `0x19e6c8`, EPG `1800000` em `0x19e6d2` e TTL geral `1209600000 ms / 14 dias` em `0x19e6dc`. Os três campos possuem flags `0x19` (`public static final`); o preset `n7.b.y` recuperado não os sobrescreve. Uma busca de candidatos `sput` nos code_items das duas DEX encontrou apenas essas atribuições, mas não é um disassembler integral nem exclui JNI/reflexão. Assim, o desenho permite rearme live, enquanto **o valor inicial desta distribuição o desliga**. O TTL de 14 dias aplica-se ao cache manual de catálogo observado; não muda a escolha `NO_CACHE` dos pedidos HTTP.

`Spark.I()` **não remove uma mensagem `18` anterior** antes de agendar outra; `K()` remove a `32`. Se o gate live fosse alterado para um valor positivo, reentradas adicionais de `I()` seriam um ponto de investigação por poderem produzir mais de uma cadeia pendente. Isso é uma possibilidade condicional, não evidência de um loop ativo nesta versão. `synchronized(manager)` cobre a construção/entrega do pedido assíncrono; não é uma prova de que só existe uma transferência em voo até seu callback terminar. O tag de OkGo identifica pedidos; não há cancelamento automático implícito demonstrado apenas pela presença do tag.

O Handler usa `WeakReference` e ignora mensagens se a activity é nula, está finalizando ou destruída. `onDestroy()` remove todas as mensagens/callbacks do Handler dessa activity e limpa a referência. Isso interrompe os timers que ainda estiverem na fila. O mesmo método cancela tarefas adicionais e um tag específico do gerenciador `utils.n0`. Não há no Java aberto uma chamada explícita `cancelTag(td.c)` ou `cancelTag(td.i)`; porém `C(String)` e `utils.i0.q()` são nativos, portanto não se afirma que pedidos de catálogo/EPG nunca sejam cancelados. `onPause`, `onStop`, `onStart` e `onResume` são nativos: não foi possível determinar se o aplicativo pausa os ciclos ao ir para segundo plano.

Consequência comprovada do desenho: uma activity aberta pode manter atualizações EPG mesmo sem interação recente. O catálogo live tem a condição de rearme, porém a inicialização atual a desabilita; pode voltar a ser solicitado por outros eventos. Isso é diferente de um processo de servidor que continua trabalhando com todos os clientes fechados. O APK não contém prova de que o serviço do provedor usa Supabase, nem explica diretamente as consultas de logs e o uso de CPU observados no ARKHEN.

## Custos e implicações para reconstrução

O ciclo live transfere e faz parse da resposta completa; ainda grava uma cópia bruta local. O ciclo EPG transfere um arquivo, invalida estruturas de memória e reprocessa-o. Há logs locais e relatórios de falha, mas não se mediu seu volume. Essas operações possuem custo mesmo sem navegação ativa. Não foram obtidos tamanhos atuais das respostas, duração de requests, tráfego por dia ou custo de backend; números anteriores de testes com contas não são usados como medida atual.

Uma reconstrução fiel pode preservar IDs e URLs fornecidos pelo serviço, separar entrega do catálogo de execução de mídia e distinguir cache de catálogo, arquivo EPG e estado de UI. O APK comprova mecanismos locais de atualização; não exige replicar um processamento global a cada leitura do frontend nem criar ingestão recorrente quando não há invalidação. Qualquer decisão desse tipo pertence à arquitetura do ARKHEN e deve ser sustentada por medições próprias, não por uma suposição sobre o original.

## Localizadores verificáveis

| Símbolo | DEX | `code_item` | Evidência REA atual |
|---|---|---:|---|
| `Spark.onCreate(Bundle)` | classes2.dex | `0x185ac0` | `ev_5eaf279f29713c77fc11fee7189083b6b03fa20667fd2ce462be8b7f6cb6e50e` |
| `td.m.e()` | classes2.dex | `0x21a078` | `ev_1188aeba6f63aa85478708dcc078ffdf307734b0fafaf160b0f7a79fd7acf3fc` |
| `Spark.U()` | classes2.dex | `0x1843f4` | `ev_30bbd66bbc52e0372e099486091172a7e240e87b056024ce4889ea87a9882e39` |
| `Spark.v()` | classes2.dex | `0x186878` | `ev_1ec33b4e4df7a2ed1b171cbe84d3a3a02a658f76e686db359b74c71391cff0fe` |
| `Spark.I()` | classes2.dex | `0x183ee4` | `ev_663025e38966e0db5913af7e01d8a6c7b8e2ac0eb106647eeb0491f0813ed86b` |
| `Spark.K()` | classes2.dex | `0x184068` | `ev_615a173f06de51ff4498aa5ca3e316dc9719b9b9e9389572366eac908204c3d3` |
| `Spark.L()` | classes2.dex | `0x1842b0` | `ev_03e2e388cb52172945a4d9556818b25e442051bce05114fa2366a485dbd1e133` |
| `e1.handleMessage(Message)` | classes2.dex | `0x19b288` | `ev_7fc236c5316535b20ef58e55ed72dcb2e82ed2f6db7a5619dea2f086c9f0cf42` |
| `utils.y.onSuccess(Response)` | classes2.dex | `0x1aca58` | `ev_c5c430b884d467ab4e080593291ae4d9db5081450fb6df84d681a509f3377c8c` |
| `utils.y.onError(Response)` | classes2.dex | `0x1ac73c` | `ev_91e31c100dcbb9e053028729819175e9868221f03072665eeabb4a2a13a5efd2` |
| `utils.y.onCacheSuccess(Response)` | classes2.dex | `0x1ac684` | `ev_59fe37a4c3cd619c2f53c830dec8241e04ec796bca4e39679164d3fa5efbe7d2` |
| `bugly.proguard.i0.run()` | classes.dex | `0x6f7c68` | `ev_1910c43c1ce38e0c8860d267800863d3b42a72add5c3ba0fbbd7915706b0b268` |
| `ae.t2.o0(int,String)` | classes2.dex | `0x13d794` | `ev_ba458facab5c120169d247aed11fd3da522887e97ffc3e74278eff9a847accf4` |
| `Spark.onDestroy()` | classes2.dex | `0x1864e8` | `ev_168324d675dc6049c771188c5a1939ef79ec639e21693c98c761a747345d5457` |
| `td.c.a()` | classes2.dex | `0x0`, native | `ev_b894f5721af4ebdb923c1043cbbdcfe7aa220584aa0fd47f6be2eb6d20a77c5b` |

O `classes.dex` atual tem SHA-256 `288b1a547c148add3c7832844095be31d70b7148815dd4a3fde2d31ea6beea7b`; `classes2.dex`, `1337876f9237570f6c5b60961a6a505bfb1d3e2dda8a89a0c923d986ff8044d2`. Os JSONs REA integrais foram preservados como evidência privada desta rodada; não integram o repositório por conterem strings internas. O arquivo público [evidencias-catalogo-epg.json](evidencias-catalogo-epg.json) conserva metadados, seletores, SHA do envelope e SHA do corpo extraído sem publicar essas constantes. Os identificadores acima localizam a extração sem divulgar contas, tokens ou endereços privados.

Referências históricas declaradas, sem revalidação dos corpos nativos nesta rodada: `analysis/WPLAYP2P-11.9.0d-auth-contract.md`, `analysis/WPLAYP2P-11.9.0d-vod-contract.md` e `analysis/WPLAYP2P-11.9.0d-epg-contract.md`. Estes nomes identificam os relatórios; não atribuem autoridade às extrações genéricas de outra versão.
