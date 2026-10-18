# 06 — Componentes, interface e ciclo de vida

## Alvo e fontes

Inspeção estática de `WPLAYP2P.apk` `11.9.0d`/`1190`, pacote `io.wareztv.android.one`, SHA-256 `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. Nenhum componente foi iniciado. Declaração no manifesto, implementação recuperada e comportamento em execução são níveis diferentes de evidência.

Fontes diretas: [manifest-primary.xml](manifest-primary.xml), envelope REA do pacote `ev_10e6cd4c74d55d8153c1a476e0a2873b3ca563cd42dfd1f8cf23bc4d3dbad0eb`, [inventário DEX](classes-primary.tsv), [métodos](metodos-primary.tsv), [campos](campos-primary.tsv) e [catálogo de evidências de reprodução](evidencias-reproducao.json). O manifesto antigo `analysis/AndroidManifest.xml` é da distribuição BinStream `12.0.3` e não foi usado como autoridade para este alvo.

## Manifesto e inicialização declarada

O APK declara `minSdkVersion=21`, `targetSdkVersion=35`, compilação 35, suporte opcional a Leanback e touchscreen, orientação landscape nas telas do produto e Application `org.bitspark.android.SpkApplication`.

Na Application: `hardwareAccelerated=true`, `largeHeap=true`, `extractNativeLibs=true`, `allowBackup=true`, `usesCleartextTraffic=true`, `testOnly=false` e factory AndroidX `CoreComponentFactory`. São valores de configuração do pacote: não certificam consumo de RAM, requisições HTTP em andamento, concessão de permissões nem conteúdo efetivamente incluído em backup. Nenhum `android:process` separado está declarado para os componentes listados.

Há **28 componentes: 15 activities, 6 services, 4 receivers e 3 providers**. Os inventários abaixo são completos para os componentes declarados neste manifesto. Views, fragments, receivers registrados em código e tarefas criadas em execução não são enumerados por esse conjunto.

## Activities e organização da interface

| Activity | Exportação explícita | Configuração/papel sustentado pela declaração |
| --- | --- | --- |
| `org.bitspark.android.Spark` | `true` | Entrada principal, splash, `singleTask`, landscape; filtros MAIN/LAUNCHER e MAIN/LEANBACK_LAUNCHER. |
| `…match.tv.GameDetailActivity` | Não declarada | Detalhe esportivo para TV; `singleTask`, landscape. |
| `…match.phone.PhoneGameDetailActivity` | Não declarada | Detalhe esportivo para telefone; `singleTask`, landscape. |
| `…match.phone.PhoneEventsScheduleActivity` | Não declarada | Agenda esportiva para telefone; `singleTask`, landscape. |
| `…match.tv.GamePlayActivity` | Não declarada | Tela esportiva de reprodução para TV; `singleTask`, landscape. |
| `…match.phone.PhoneGamePlayActivity` | Não declarada | Tela esportiva de reprodução para telefone; `singleTask`, landscape. |
| `…match.phone.PhoneLeagueEventsActivity` | Não declarada | Eventos de liga para telefone, fullscreen declarado. |
| `…match.phone.PhoneRankingActivity` | Não declarada | Ranking para telefone. |
| `…match.tv.EventsScheduleActivity` | Não declarada | Agenda esportiva para TV. |
| `…match.tv.LeagueEventsActivity` | Não declarada | Eventos de liga para TV. |
| `…match.tv.RankingActivity` | Não declarada | Ranking para TV. |
| `…payment.PaymentActivity` | `false` | Tela de pagamento; `singleTask`, landscape. |
| `com.google.android.gms.common.api.GoogleApiActivity` | `false` | Tela translúcida da dependência Google. |
| `ly.count.android.sdk.messaging.CountlyPushActivity` | `false` | Tela transitória; `noHistory=true`, excluída dos recentes. |
| `ly.count.android.sdk.TransparentActivity` | Não declarada | Tela translúcida do SDK Countly. |

`…` nas linhas do produto expande para `org.bitspark.android`. As linhas com exportação omitida não têm intent-filter no manifesto. A tabela preserva o atributo real, sem inventar uma API pública para essas telas nem certificar regras de dispatch de cada versão do Android.

`Spark` contém um único shell com áreas de TV/VOD, histórico, usuário, aplicativos, configurações, início, esportes e pagamento. Em `Spark.onCreate(Bundle)` o Java recuperado vincula os recursos `rb_menu/rb_vod/rb_history/rb_user/rb_apps/rb_setting/rb_home/rb_match/rb_payment`, `main_vp`, listas Leanback de VOD/episódios/temporadas, `rv_source`, controles de EPG atual/próximo, seekbars, download e Cast. Isso sustenta organização de UI; não prova que cada área receba dados ou esteja habilitada para uma conta.

O mesmo método vincula `video_view` a `VideoView` e `exoPlayerView` a Media3 `PlayerView` e chama o método protegido `i1()`. Evidência fresca REA `ev_5eaf279f29713c77fc11fee7189083b6b03fa20667fd2ce462be8b7f6cb6e50e`: `classes2.dex` `code_item=0x185ac0`, instruções `0x185ad0`.

Em outro método Java completo, `Spark.v()` (`code_item=0x186878`, REA `ev_1ec33b4e4df7a2ed1b171cbe84d3a3a02a658f76e686db359b74c71391cff0fe`), aparecem os listeners de preparação/conclusão/erro/info do `VideoView`, construção do adaptador `te.e` com essa view, preparação dos fragments/adaptadores e listeners de navegação. Isso evita atribuir ao bootstrap de views uma política nativa de player que não foi recuperada. Os IDs de recursos e listeners são evidência estrutural de interface; nenhum screenshot/UI em funcionamento foi obtido nesta investigação.

## Services

| Service | Atributos relevantes | Limite da conclusão |
| --- | --- | --- |
| `com.tvbus.engine.TVService` | Sem filtro, exportação não declarada | Serviço da TVCore. `onBind/onCreate/onDestroy/onStartCommand` são nativos; não se recuperou do Java a política de restart, bind ou encerramento. |
| `org.bitspark.android.offline.VodOfflineDownloadService` | `exported=false`, `foregroundServiceType=dataSync` | Subclasse Media3 `DownloadService`; `getDownloadManager/getScheduler` são nativos. Tipo foreground não prova serviço ativo ou download ocioso. |
| `com.google.android.gms.cast.framework.ReconnectionService` | `exported=false` | Infraestrutura Cast empacotada. |
| `androidx.room.MultiInstanceInvalidationService` | `exported=false`, `directBootAware=true` | Invalidação da dependência Room; não é um job de refresh de catálogo comprovado. |
| `com.google.android.datatransport.runtime.backends.TransportBackendDiscovery` | `exported=false`, metadado `CctBackendFactory` | Descoberta de backend da dependência DataTransport. |
| `com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService` | `exported=false`, permissão `BIND_JOB_SERVICE` | Integração com JobScheduler da dependência; não demonstra frequência ou payload dos jobs criados. |

`TVService` tem `class_def=classes.dex:0x152ff4`. Seus quatro callbacks de Service têm `flags=0x101` e `code_item=0`. O REA fresco de `onCreate` confirma `body_status=not_available`: `ev_66c1b080dd8a6cac6a0c5cf76ec5fd0eb7bcacba63e022d7dd7ed8f688408661`. Esse é um limite real de decompilação, não um callback vazio.

A classe interna `TVService.TVServer` implementa o `Runnable` comum analisado no [capítulo 05](05-reproducao-e-memoria.md): configura porta 8902/modo 1 e executa `run()` somente se `init(applicationContext)==0`. A existência deste método não revela, sozinha, a thread/cadência criada pelo callback nativo do serviço.

`VodOfflineDownloadService` tem `class_def=classes2.dex:0x6dba8`; construtor comum `0x1a5580`, `getForegroundNotification(List,int)` comum `0x1a559c`; aquisição do manager/scheduler continua nativa. Não há neste inventário um serviço próprio WorkManager declarado. Isso não exclui timers, Handler, Rx, AlarmManager ou tarefas agendadas em código.

## Receivers

| Receiver | Exportação/permissão | Ações declaradas e limite |
| --- | --- | --- |
| `org.bitspark.android.broadcast.ActionReceiver` | `exported=true` | `BOOT_COMPLETED`, `SCREEN_OFF`, `SCREEN_ON`, `CONNECTIVITY_CHANGE`, `TIME_SET`. `onReceive(Context,Intent)` é nativo; efeito/restart/debounce de cada ação não recuperado. |
| `com.google.android.gms.cast.framework.media.MediaIntentReceiver` | `exported=false` | Receptor da dependência Cast; sem filtro neste manifesto. |
| `androidx.profileinstaller.ProfileInstallReceiver` | `exported=true`, permissão `DUMP` | Quatro ações de instalar/pular/salvar perfil/benchmark da biblioteca AndroidX. Não é entrada de reprodução. |
| `com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver` | `exported=false` | Componente da dependência de transporte; sem periodicidade demonstrada pela declaração. |

`ActionReceiver` tem `class_def=classes2.dex:0x6b9a8`, `<clinit>` comum `0x18eb88` e `onReceive` nativo `flags=0x111`, `code_item=0`. Portanto, recepção de boot/tela/rede é uma hipótese concreta de entrada de lifecycle a investigar, sem afirmar que ela mantém streaming/requisições ativos no fundo.

## Providers e inicializadores

| Provider | Configuração | Função identificada |
| --- | --- | --- |
| `androidx.core.content.FileProvider` | `exported=false`, `grantUriPermissions=true`, `@xml/provider_paths` | Compartilhamento de arquivos pela configuração declarada. Conteúdo servido em execução não foi consultado. |
| `androidx.startup.InitializationProvider` | `exported=false` | Metadados `EmojiCompatInitializer`, `ProcessLifecycleInitializer`, `ProfileInstallerInitializer`. |
| `me.jessyan.autosize.InitProvider` | `exported=false`, `multiprocess=true` | Inicializador da dependência de escala de UI. |

Há ainda metadados de `CastOptionsProvider`, integração Glide/OkHttp e layout de referência `960×540` dp. Esses nomes indicam integrações incluídas, sem provar chamadas remotas, cache efetivo ou tráfego ocioso.

## Permissões e limites de recursos

O manifesto solicita 17 permissões: rede/estado de rede/Wi-Fi; leitura de telefonia; permissões legadas de proprietário e armazenamento; boot; wake lock; áudio; overlay; instalação de pacotes; foreground service/dataSync; montagem de filesystem e a permissão própria de receptor dinâmico. Declara também duas permissões próprias de nível `signature` para broadcast Countly e receptor dinâmico.

Uma permissão solicitada não equivale a concessão no dispositivo ou uso por uma rotina. Em particular, `WAKE_LOCK`, boot e service no pacote não comprovam que uma reprodução continue após tela desligada. `usesCleartextTraffic=true` permite configuração de HTTP claro, sem identificar quais requisições foram feitas. A investigação de rede/armazenamento deve consultar os capítulos próprios do dossiê, preservando estes limites.

## Ciclo de vida recuperado

| Ponto de entrada | Evidência atual | Conclusão sustentada |
| --- | --- | --- |
| `SpkApplication.onCreate` | Método Java em `classes2.dex:0x188508` | Bootstrap comum do processo pode ser inspecionado; integrações/configurações detalhadas são tratadas na análise de rede/armazenamento. |
| `Spark.onCreate` | Java completo, `0x185ac0`, REA fresco | Montagem do shell, associação de views/listeners e chamada de inicialização protegida. |
| `Spark.onStart/onResume/onPause/onStop` | Quatro métodos `native`, `flags=0x111`, `code_item=0` | Não se certifica deles a sequência pause/stop/restart/release. |
| `Spark.onNewIntent` | `native` no DEX; mapeamento de VM histórico limitado | Não há contrato de seleção por deeplink demonstrado. |
| `Spark.onDestroy` | Java completo, `0x1864e8`, REA fresco | Há teardown explícito de várias referências, listeners, tarefas e `VideoView`, detalhado abaixo. |
| `TVService` callbacks | Nativos | Restart/stop automático e valor retornado por `onStartCommand` não recuperados. |
| `ActionReceiver.onReceive` | Nativo | Ações de boot/tela/rede declaradas, mas sem semântica recuperada por ação. |

`Spark` possui 128 métodos declarados, dos quais 112 nativos. O fato de `onCreate/onDestroy` possuírem Java legível não torna legíveis os pontos intermediários de seleção e reprodução.

### O que `Spark.onDestroy` cancela de fato

Evidência fresca `ev_168324d675dc6049c771188c5a1939ef79ec639e21693c98c761a747345d5457`; `classes2.dex` `code_item=0x1864e8`, instruções `0x1864f8`. A decompilação completa mostra:

1. Limpeza do request manager Glide, remoção de listeners registrados na Application e unregister do EventBus.
2. Remoção de callbacks/mensagens de handlers usados por VOD e pela Activity; limpeza da `WeakReference` da Activity no `e1` quando corresponde à instância destruída.
3. Cancelamento de uma tarefa `utils.q0`, fechamento de diálogo e chamada de `utils.i0.q()`, que é nativa.
4. Remoção dos listeners de teclado/toque/preparação/conclusão/erro/info do `VideoView` estático; `stopPlayback()` e atribuição da referência a `null`.
5. Limpeza de RecyclerView/adaptador de fontes e reset de flags/contadores/callbacks do objeto `u0`.
6. Reset de referências/estado de `te.g`; chamada de limpeza `he.e.a().d()`.
7. `OkGo.cancelTag(n0.c)`, cancelamento de inscrição Rx associada e limpeza das referências/flags deste helper; limpeza Cast; `super.onDestroy()`.

O método também chama `Spark.C(String)`, nativo. Não há chamada direta legível a `TVCore.stop()` ou `ExoPlayer.release()` nesse corpo Java. Isso **não prova ausência de liberação**: ela pode acontecer nos métodos nativos chamados ou em outro callback. Reciprocamente, `VideoView.stopPlayback()` não certifica que a engine P2P, conexões, peers e caches tenham parado.

Esse teardown é atrelado a `onDestroy`; não foi demonstrado que ele rode a cada troca de canal, pause de UI ou SCREEN_OFF. Tampouco o método é garantia de limpeza após encerramento abrupto do processo.

### STOP, troca de canal e callbacks da engine

`te.c` define `stop/release`, `TVCore` define `stop()`, `stop(int)` e `quit()`, e `Libtvcar` define `release()`. Essas superfícies são distintas. Os corpos de `te.d.stop/release`, `te.e.stop/release`, seleção `Spark.n0/p0/h0` e lifecycle intermediário são nativos. A reconstrução da ordem “parar antiga → invalidar callbacks → preparar nova → conectar player” não está completa.

O relatório histórico estático do mesmo APK identificou no parser `Spark.t` os eventos `onInited`, `onStart`, `onPrepared`, `onStop` e `onInfo`, com campos numéricos/telemetria e saídas `hls/http`. A interface `TVListener` declara também `onQuit`. O relatório identificou tratamento de erros de autenticação no listener `i0.onInited`, `classes2.dex:0x19ee9c`. Não se inferiu desses nomes correlação por geração de canal, descarte de callbacks atrasados ou confirmação de término de download/upload. O capítulo 05 preserva os offsets e a distinção entre evidência histórica e fresca.

## Intents externos: limite demonstrado

Os filtros da `Spark` declaram `MAIN`; um inclui `BROWSABLE`, mas não há `ACTION_VIEW`, `data`, esquema/host de mídia ou extras de reprodução anunciados no manifesto. A Activity ser exportada não estabelece um contrato externo para iniciar um canal.

O relatório histórico do mesmo SHA `analysis/WPLAYP2P-11.9.0d-playback-intents.md` corrigiu um mapeamento anterior e reduziu `Spark.onNewIntent(Intent)` a uma VM de **7 words**: wrapper `libijkplayer.so:0xf4268`, VM `0x8b822`; chamadas `super.onNewIntent`, `setIntent` e retorno (`0x8b822/0x8b828/0x8b82e`). Esse trecho histórico não seleciona canal ou inicia engine. O corpo continua nativo para a inspeção REA atual; o mapeamento protegido não foi refeito nesta sessão.

Portanto, não foi demonstrada uma API de controle de reprodução via intent, deep link, broadcast ou provider. Os serviços/receivers declarados não devem ser convertidos em protocolo de controle por adivinhação.

## Pendências estáticas e conclusão operacional

Para explicar com precisão continuidade em background e troca de canal, faltam os corpos protegidos dos quatro callbacks intermediários da Activity, callbacks do Service/Receiver e adaptadores `te.d/te.e`, além das arestas de start/stop e callbacks de canal. Falta ainda recuperar a política concreta de JobScheduler/AlarmManager/DownloadManager criada em código; a lista de componentes não fornece cadências.

As conclusões deste capítulo sustentam um mapa de responsabilidades e pontos de investigação. Elas não medem tarefas ativas, RAM/RSS, consumo de rede, cache em disco ou latência, e não certificam que o APK explique o incidente do Supabase. Nenhum aplicativo, backend, cron ou player foi alterado por esta etapa de análise.
