# Armazenamento, memória e cache do WPLAY

Data: 16/17 de outubro de 2026. Alvo: `WPLAYP2P.apk`, versão `11.9.0d` / `1190`, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. Inspeção estática por REA/JADX e leitura direta de DEX, sem executar APK, emulador, mídia, navegador, testes ou chamadas ao provedor.

**Observado** descreve bytecode, campos ou chamadas presentes neste artefato. **Inferido** identifica a consequência provável desses mecanismos, sem medida em execução. **Lacuna** indica corpo protegido ou comportamento ainda não demonstrado. A existência de uma classe de cache não comprova que toda informação passe por ela.

O APK mantém camadas distintas: listas e índices em RAM, um cache de metadados em arquivos, o arquivo bruto de EPG, preferências, Room e downloads de mídia Media3. O limite de aproximadamente 20 MB pertence ao `ACache` de arquivos; não é um limite comprovado para toda a RAM, SQLite, EPG ou downloads offline.

## Mapa das camadas

| Conteúdo | Meio observado | Política comprovada | Limite da conclusão |
|---|---|---|---|
| Catálogo live interpretado | `td.c.f16086b`, lista de `ChannelBean` em RAM | A resposta completa é convertida em lista; erro pode substituí-la por lista vazia. | Indexação adicional em `td.c.a()` é nativa. Não se mediu tamanho da lista/heap. |
| Catálogo live bruto de fallback | Arquivo no `ACache`, escrito por `rd.a` | Cabeçalho com data de gravação e TTL; chamada live usa 14 dias no valor inicial. Leitura ocorre no callback de erro. | O cache não torna o GET live uma leitura HTTP de cache. Gravação e publicação em RAM são separadas. |
| Objetos serializados genéricos | `rd.c.b/d/e/f`, no mesmo gerenciador de arquivos | Serialização Java e TTL opcional. | `rd.c.b` não é o leitor textual do catálogo. Não se deduz quais outros modelos o utilizam. |
| EPG transferido | `getCacheDir()/epg.data` | Download de um arquivo; parser recebe limites de tempo. | Não foi demonstrado fallback desse arquivo no erro de download, nem limite em bytes. |
| EPG consultado localmente | `td.i` com `ConcurrentHashMap`, `LruCache(20)` e formatadores/calendários | Invalidação em cada novo parse. | Métodos de inserção/consulta são nativos; não se mediu o conteúdo por entrada nem o heap total. |
| Categorias e páginas VOD | Lista de grupos e cache por categoria em objetos de UI | Reaproveita lista por categoria antes de pedir página inicial. | Não foi recuperada uma política integral de persistência/expiração das páginas VOD. |
| Preferências | SharedPreferences | Locale e flags do SDK têm arquivos identificados. | Getters/setters de preferências do aplicativo em `utils.i0` são nativos. Não se publica conteúdo de conta. |
| Inscrições em partidas | Room `AppDatabase` / `AppDatabase_Impl` | Tracker identifica `match_subscribe`. | Schema/migrações são protegidos; não há prova de que catálogo ou EPG sejam tabelas Room. |
| Mídia VOD offline | `filesDir/media3_vod_offline`, `SimpleCache`, banco Media3 | `NoOpCacheEvictor`, `DownloadManager`, máximo de 2 downloads paralelos. | Sem quota ou TTL de mídia demonstrados nesse inicializador; não herda os 20 MB do `ACache`. |

Os fluxos de rede, parsing e rearme estão em [03-catalogo-e-rede.md](03-catalogo-e-rede.md) e [04-epg-e-atualizacao.md](04-epg-e-atualizacao.md). Reprodução e buffers pertencem a [05-reproducao-e-memoria.md](05-reproducao-e-memoria.md).

## Cache manual de metadados em arquivos

**Observado:** `Spark.v()` monta candidatos `ACache` sob `getFilesDir()`, `getCacheDir()` e, quando disponível, `getExternalCacheDir()`. Primeiro procura uma instância já presente no mapa estático `rd.c.f14267c` para esses caminhos. Se não encontra, escolhe em ordem o primeiro diretório que exista ou possa criar, recupera/cria `rd.c` e um `c2.a(File)` e atribui-o a `Spark.f12722m3`. A chave do mapa combina caminho e sufixo. Não se afirma que as três localizações são utilizadas simultaneamente: são alternativas da construção observada.

`c2.a(File)` configura **20.000.000 bytes** (cerca de 19,1 MiB) e **1.000 arquivos**, cria contadores atômicos, um mapa sincronizado de arquivos/timestamps e inicia um worker de inventário. `c2.a.f(String)` deriva o nome do arquivo de `String.hashCode()` decimal; não preserva o nome textual da chave no pathname. Isso é um mapeamento por hash, sem evidência de tratamento adicional de colisões nesse método.

Ao ler um arquivo por `c2.a.c(String)`, atualiza `lastModified` e o mapa de timestamps. Depois da escrita, `c2.a.a(...)` ajusta contagem/tamanho e chama `j()` enquanto precisa liberar espaço/quantidade. `j()` percorre o mapa e escolhe o menor timestamp, tenta remover o arquivo e devolve seu tamanho. Assim, o descarte observado segue o acesso/gravação mais antigo registrado. Os loops possuem saída quando a vítima devolve tamanho zero: a configuração é uma política de descarte, não prova de um teto físico absoluto em toda condição de falha ou concorrência.

### Formato e expiração

`xc.a.z(int ttlSeconds)` produz um prefixo textual:

```text
<epoch da gravação em ms, preenchido a 13 dígitos>-<TTL em segundos><espaço><corpo>
```

`xc.a.O(byte[])` reconhece o cabeçalho por `M`, extrai timestamp/TTL e considera vencido quando `System.currentTimeMillis() > timestamp + ttlSeconds * 1000`. Sem cabeçalho reconhecido, esse helper retorna falso; isso não atribui TTL às entradas que não o possuam. O TTL é contado desde a **gravação**, enquanto o timestamp de acesso serve ao descarte por espaço; ler o arquivo não renova o cabeçalho de expiração demonstrado.

O caminho genérico `rd.c.d(key,Serializable,ttl)` usa `ObjectOutputStream`. Se TTL difere de `-1`, `f()` acrescenta o cabeçalho antes de `e()` escrever bytes. `rd.c.b(key)` lê os bytes, remove a entrada se vencida, retira o cabeçalho e usa `ObjectInputStream`. Este formato genérico é diferente da resposta JSON textual do catálogo.

No catálogo live, `utils.y.onSuccess`, caso `1`, remove a chave antiga e inicia `rd.a` com `xc.a.z(h.f12948i / 1000) + response.body()`. `rd.a.run()` grava texto por `BufferedWriter(FileWriter(...),1024)` e faz a contabilização de tamanho. `utils.y.onError`, caso `1`, lê esse arquivo com `BufferedReader`, verifica TTL, retira o prefixo e encaminha o texto recuperado ao mesmo parser do catálogo. A decompilação do callback possui avisos de inferência; comprova essas chamadas explícitas, sem certificar todos os detalhes do loop reconstruído.

**Inferido:** manter resposta bruta permite apresentar catálogo após falha de rede dentro da validade da entrada. **Lacuna:** o código recuperado não demonstra uma transação única entre remover a versão anterior, escrever a nova e publicar a lista em RAM. Não foi verificado rename atômico, durabilidade após interrupção ou sincronização de duas gravações simultâneas. Nenhuma falha real de arquivo foi provocada.

## Valores iniciais de refresh e TTL

O bytecode de `org.bitspark.android.h.<clinit>()`, `classes2.dex` / `code_item 0x19e69c`, atribui estes inteiros:

| Campo DEX / alias JADX | Valor inicial | Uso observado | Offset da atribuição |
|---|---:|---|---:|
| `g:I` / `f12946g` | `-1` | `Spark.I` só rearma catálogo quando maior que zero; esse valor inicial desliga aquele rearme. | `0x19e6c8` |
| `h:I` / `f12947h` | `1800000 ms` / 30 minutos | Atraso da mensagem EPG `32`. | `0x19e6d2` |
| `i:I` / `f12948i` | `1209600000 ms` / 14 dias | `OkGo.setCacheTime` e TTL do cache manual de catálogo, convertido a segundos na gravação. | `0x19e6dc` |

Os campos têm flags DEX `0x19` (`public static final`). O preset `n7.b.y` recuperado não os sobrescreve. Uma busca limitada de palavras candidatas `sput` dentro dos code_items das duas DEX encontrou somente essas três atribuições; não é uma auditoria integral de instruções e não exclui JNI/reflexão. O preset tem atribuições a outros gates, inclusive `h.k`/`h.l`; sua existência não prova seleção/execução em uma conta.

A ferramenta REA não entregou Java de `h.<clinit>`, embora o DEX confirme bytecode não nativo. Por isso os números foram lidos diretamente das instruções, com propagação apenas de literais numéricos, sem executar `NativeUtil` ou qualquer chamada do aplicativo. A reprodução está em [ferramentas/extrair_timers_cache.py](ferramentas/extrair_timers_cache.py), restrita ao SHA deste APK, e o resultado sanitizado em [timers-cache-primary.json](timers-cache-primary.json). Não se inventou Evidence ID REA para essa leitura direta.

Os GETs live e EPG configuram `CacheMode.NO_CACHE`. A configuração global de 14 dias do OkGo não demonstra cache HTTP efetivo nesses pedidos. O catálogo tem seu cache manual comprovado independentemente. O corpo de `utils.i0.h(String)`, que constrói o `OkHttpClient`, é nativo: cache HTTP em disco, cookies, pool/conexões, DNS efetivo e outros limites desse cliente permanecem não resolvidos. `utils.i0.f13332g` tem tipo de resolvedor DNS (`utils.g`); não é prova de um cache de catálogo.

## EPG: disco, RAM e retenção

`Spark.K()` configura `FileCallback` para `cacheDir/epg.data` e escolhe `NO_CACHE`. `td.e.onSuccess` inicia `td.f` com o arquivo recebido. O erro de download envia a mensagem de continuidade da tela e não reabre explicitamente o arquivo antigo. A presença de `epg.data` em disco, por si só, não comprova uso após falha ou após reinício do processo.

`td.i.<clinit>` cria `ConcurrentHashMap`, `new LruCache(20)`, calendários via `j1(3)`/`j1(4)`, fuso UTC e formatadores. Os nomes decodificados são a chave `BSEPG` e o prefixo `chan-epg-day-`. O LRU é uma instância direta da classe Android com capacidade declarada de 20 entradas; isso não significa 20 programas nem 20 MB. Métodos que constroem a chave, inserem dados e consultam programas são nativos no DEX atual, portanto a associação exata canal/dia depende de evidência histórica separada e não foi revalidada aqui.

Antes do parse, `td.f.run()` limpa o mapa e chama `evictAll()` no LRU. Passa ao parser `upper = utils.i0.e(now + clockOffset + 86400000)` e `lower = h.k ? Long.MIN_VALUE : upper - 172800000`. Na volta normal limpa o mapa novamente e sinaliza a UI; em exceção não restaura os caches explicitamente. O corpo do normalizador `utils.i0.e` e do parser `td.i.a` é protegido. É observável a janela passada e a invalidação, sem provar a retenção real final em disco/RAM nem uma troca atômica da grade. A discussão de falhas e fronteiras está em [04-epg-e-atualizacao.md](04-epg-e-atualizacao.md).

`td.i.j(String)` retorna epoch em milissegundos, tem caminho rápido para ISO de 24 caracteres terminando em `Z`, calendário reutilizável por thread e fallback de `SimpleDateFormat` sincronizado. Nulo/vazio retorna `Long.MIN_VALUE`. Reuso de objetos reduz alocações de conversão; esta é uma consequência estrutural, não medida de desempenho Android.

**Lacunas:** não foi demonstrado que todo o EPG esteja simultaneamente em RAM, nem que o LRU seja a única fonte local. O contrato histórico descreve agrupamento por canal/dia, mas seus dumps nativos intermediários não existem nesta rodada. Não foram medidos tamanho de `epg.data`, quantidade de entradas, heap, cobertura temporal efetiva ou custo do parse.

## SharedPreferences e bancos

`SpkApplication.onCreate` usa `getSharedPreferences("lingver_preference",0)` e a chave `follow_system_locale_key` para locale. Separadamente, `ua.c.J(Context)` mantém um singleton de SharedPreferences, mas sua fábrica `new l8.b(0,context).call()` abre **`google_sdk_flags`**: é caminho de flags do SDK, sem prova de que guarde o catálogo ou as credenciais do aplicativo.

`utils.i0` expõe getters/setters de String, boolean, inteiro e conjunto de strings, porém seus corpos são nativos. Sua presença é insuficiente para afirmar nomes/valores reais das preferências de autenticação, histórico ou favoritos. Esses dados não foram extraídos de dispositivo e não integram este documento.

`org.bitspark.android.db.AppDatabase` estende `RoomDatabase`. `AppDatabase_Impl.createInvalidationTracker()` retorna um tracker com a tabela decodificada **`match_subscribe`**. `createOpenDelegate`, auto migrations e metadados de conversores estão protegidos como métodos nativos. Isso comprova a declaração de pelo menos uma entidade Room de inscrições, sem observar a criação real do banco em execução; não autoriza atribuir a Room o catálogo, a grade EPG ou todo o armazenamento SQLite do APK. O caminho/nome do arquivo de banco e schema completo não foram demonstrados.

Há ainda persistência de logs própria: `SpkApplication.onCreate` instala `Xlog`, chama `Xlog.open`, desliga o log no console e invoca helpers `utils.s0.a/e` sobre o diretório de logs. Isso comprova inicialização e uma etapa de manutenção, sem quantificar retenção, tamanho ou envios. `CrashReport.initCrashReport` é configurado separadamente. Logs locais/telemetria Android não equivalem ao volume de consulta de logs exibido no Supabase do ARKHEN.

## Mídia VOD offline

`SpkApplication.onCreate` chama `se.i.l().q(this)`. `se.i.q(Context)` é sincronizado e retorna cedo se o `DownloadManager` já existe; usa o contexto da aplicação, instancia `StandaloneDatabaseProvider`, `SimpleCache(new File(filesDir,f15218t),new NoOpCacheEvictor(),provider)` e `DownloadManager` apoiado por esse cache. A constante `f15218t` decodifica para **`media3_vod_offline`**, e o identificador de log para `VodOfflineManager`.

O inicializador cria executor fixo de 2 threads e outro de uma thread, aplica `setMaxParallelDownloads(2)` e registra listener. O inventário mostra também mapas concorrentes para o estado de downloads. `VodOfflineDownloadService` estende `androidx.media3.exoplayer.offline.DownloadService`; o getter do gerenciador e grande parte das operações de incluir/remover/reproduzir download são nativas.

`NoOpCacheEvictor` indica ausência de descarte automático por aquele evictor. O método aberto não configura quota de bytes nem TTL de mídia. Isso não prova retenção eterna: a aplicação pode remover downloads por caminhos protegidos, e o dispositivo pode ser desinstalado/limpo. Também não prova que a reprodução online de TV/VOD use esse mesmo cache. Os 20.000.000 bytes e 1.000 arquivos do `ACache` não se aplicam a `media3_vod_offline` por associação de nome.

## Evidência e limites de proveniência

Todos os offsets seguintes são relativos ao DEX descomprimido. `0x0` em método nativo significa ausência de corpo Java naquele DEX, sem localizar a implementação nativa. Flags/descritores foram conferidos no [metodos-primary.tsv](metodos-primary.tsv) e [campos-primary.tsv](campos-primary.tsv). Os envelopes REA completos permanecem privados; o ledger [evidencias-armazenamento.json](evidencias-armazenamento.json) conserva SHA dos envelopes/corpos, seletores e IDs sem constantes internas ou URLs.

| Símbolo / assunto | DEX / `code_item` | Evidence ID atual |
|---|---|---|
| `Spark.v` / construção `ACache` | classes2 / `0x186878` | `ev_1ec33b4e4df7a2ed1b171cbe84d3a3a02a658f76e686db359b74c71391cff0fe` |
| `utils.y.onSuccess` / gravação live | classes2 / `0x1aca58` | `ev_c5c430b884d467ab4e080593291ae4d9db5081450fb6df84d681a509f3377c8c` |
| `utils.y.onError` / leitura textual | classes2 / `0x1ac73c` | `ev_91e31c100dcbb9e053028729819175e9868221f03072665eeabb4a2a13a5efd2` |
| `c2.a(File)` / limites | classes / `0x5f18fc` | `ev_63a34c6e47eb9d31b8f6d083b54f4d03b9bbda4fb63285c177124a8228fe7fd0` |
| `c2.a.a` / descarte e contabilização | classes / `0x5f1978` | `ev_21c54243293a35501b367784d197bcb6ccaba228d18fb1c2e5846ebe99083303` |
| `c2.a.j` / vítima mais antiga | classes / `0x5f1d1c` | `ev_84f4a675d6790c9bd50b00d3fe73f9de76707d478e807157dbf9bfd41260d660` |
| `c2.a.c/f` / acesso e nome do arquivo | classes / `0x5f1ad4`, `0x5f1b58` | `ev_135c6bd5e840a5ec2caed3b9362baa46cba4237d3912883fcacf2ace9da2ff9d`, `ev_d1d61ba267050db3db5945e88fd1c718ff1a2ae720d35375ff68248a70deccb9` |
| `rd.a.run` / escritor de texto | classes2 / `0x1c4274` | `ev_bd384cc57aa5236ad466afd9741eb2103e8c8e9c69ef0c9854493b3aafdd2d6b` |
| `rd.c.b/d` / serialização | classes2 / `0x1c490c`, `0x1c4bb4` | `ev_4dac845ad22fb3b89eb46e75554fdab42d6f6a7b71bb91276c27477319970c59`, `ev_a4bab36c0b890f105a393e95c20ba6ff3fb4e99f1a06ffeb59d762536f6cb411` |
| `xc.a.z/O` / TTL | classes / `0x7e7788`, `0x7e21b4` | `ev_5eaf6bc7bd9e14d5de4724300e3a8ae8810c41560e507f9664238f7b6f61ef6a`, `ev_b5335e6fa8f074015bfe1900c649bd25418b915998a138c5debe94cce89b3c55` |
| `td.i.<clinit>` / estruturas EPG | classes2 / `0x219544` | `ev_40aefb7c0d52b4371f5462a25bd46b0fe61a78804640b77a482eefa7f831fdaa` |
| `td.i.j` / datas | classes2 / `0x219628` | `ev_0816af624bf3af343ad5d3b3359ba87aaeb2016aa6aa11520f954c1d3db3f6e4` |
| `SpkApplication.onCreate` | classes2 / `0x188508` | `ev_c7a313131b64ebe63a481716966bd322eb87065c95d7253f8ce9275871d8c7d5` |
| `ua.c.J` / singleton SDK | classes2 / `0x229478` | `ev_e61083749f64f6821c49d120713c6d25ab46b673c2ec571726c4b629730edb8e` |
| `l8.b.call` / `google_sdk_flags` | classes / `0x7769e4` | `ev_2351056e046de2758046575f2541678e1abe5ca60dc47093d17547bb2ac58fab` |
| `AppDatabase_Impl.createInvalidationTracker` | classes2 / `0x19a0ac` | `ev_9c4a6b6b43aea9a30141b701edc3df3c6d249c6ecd887aa621665f6ef09bb271` |
| `se.i.q` / mídia offline | classes2 / `0x1f4304` | `ev_f8264fdb5b1291ba063251991578665c81a2dd78e6d86a7c7d0d2dc138be8b38` |
| `se.i.<clinit>` / diretório offline | classes2 / `0x1f38c4` | `ev_24b996dd9979a455e907e92872fa2d1e23b0bbfb13733653571ec6f1671c84cb` |
| `ua.c.l` / transformação de constantes | classes2 / `0x22965c` | `ev_27d8bb392b3faa302645789b6b76d3f1e92f80c1d5379f55fca98ebb89f9cb50` |

SHA-256 dos membros: `classes.dex` = `288b1a547c148add3c7832844095be31d70b7148815dd4a3fde2d31ea6beea7b`; `classes2.dex` = `1337876f9237570f6c5b60961a6a505bfb1d3e2dda8a89a0c923d986ff8044d2`. Os nomes selecionados acima foram decodificados estaticamente pelo algoritmo Base64/XOR visível em `ua.c.l`; não se decodificaram URLs privadas para a documentação.

As extrações genéricas em `analysis/metadata.json`, `analysis/methods` e `analysis/native` pertencem à distribuição 12.0.3 e não validam corpos ou offsets desta 11.9.0d. Os relatórios históricos específicos do primário foram usados apenas como contexto com lacunas explícitas. Esta análise não observou arquivos/preferências/banco de uma instalação real nem mediu tráfego, CPU, heap ou armazenamento ocupado.

O desenho comprovado reutiliza metadados e estado de programa localmente. O fallback live, porém, é consultado após erro e não evita o GET inicial `NO_CACHE`; o ciclo EPG também pode refazer download/parse do arquivo. Isso descreve o cliente Android; não estabelece o backend original, não prova uso de Supabase e não mede a causa dos 98% de CPU do ARKHEN. A comparação com as rotinas e métricas próprias do ARKHEN deve conservar essa separação de evidência.
