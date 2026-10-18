# Canais do Início

Integração implementada em `web/app.js`, 16/10/2026. Este módulo apresenta a projeção privada da RPC; não calcula popularidade no navegador nem cria uma conexão com o provedor.

## Apresentação

`HomeChannelShelf`, de `visualizacao.js`, recebe o DTO `{featuredId, mostWatchedId, items:[{item, reason}]}`. Mantém a ordem do servidor, até cinco IDs distintos: um destaque à esquerda e até quatro recentes. `reason` é `most-watched`, `default-globo` ou `recent`. O destaque semanal usa o rótulo “Mais assistido · 7 dias”; o padrão enviado pela RPC usa “Seu canal ao vivo”, sem alegar histórico. No padrão, `mostWatchedId` é nulo e `featuredId` identifica o canal enviado. O nome regional é apresentado integralmente, sem inferir a localização do usuário.

Somente o primeiro item, com motivo de destaque e ID correspondente a `featuredId`, recebe a moldura branca. Todos os cards usam logo; não há prévia ou abertura automática de mídia. A área da logo conserva3:2 (84×56px no desktop,63×42px no celular), proporção usada por `logoGeometry`; uma área quadrada distorce os recortes transparentes. DTOs antigos sem `featuredId` continuam usando `mostWatchedId`. A UI não escolhe Globo, não preenche posições ausentes e não promove um recente a destaque. Os cinco cards ficam na mesma linha em telas largas, com área de imagem limitada a124px; três colunas até1050px, duas até650px e uma até340px. Horários e nomes extensos ficam contidos no card.

```js
const homeTV = new HomeChannelShelf({
  getScope: () => playbackAccountScope(), // conta + geração Auth estáveis
  isActive: () => homeVisible && !player && !document.hidden,
  createLogo: item => createFavoriteChannelLogo(item),
  createFavorite: item => makeFavorite(item),
  refreshFavorite: (button, item) => updateFavoriteButton(button, item),
  onWatch: (item, {stopped}) => openPlayer(item, null, {
    beforePlayback: stopped,
    fullscreen: true,
  }),
  onMore: () => setView('live'),
  onRetry: () => homeTVModel.ensure({force: true}),

});
const section = homeTV.render(existingSection, homeTVModel.state.data || {}, homeTVModel.state);
container.append(section);
homeTV.sync();
```

### Programação atual

`getItems()` devolve uma cópia do array dos itens apresentados, na ordem da RPC. O proprietário registra esses IDs no serviço de grade compartilhado e fornece os resultados normalizados:

```js
const items = homeTV.getItems();
const dataById = new Map(items.map(item => [item.id, tvGuide.peek(item.id)]));
homeTV.updatePrograms(dataById, tvGuide.state);
```

`updatePrograms(dataById, state={})` aceita `Map` ou objeto por ID. Cada valor é o payload normalizado da grade, com `window.current`, `window.next`, `startLabel`, `endLabel` e `progressPercent`. Usa `programWindow` apenas como presenter: a RPC continua escolhendo o programa, os horários e o percentual. Não consulta relógio, calcula janela, cria timer ou faz request por card.

O bloco dentro de cada card apresenta somente “Agora”, seus horários e o progresso recebido. `window.next` não é mostrado. `loading`, `error` e `stale` são apresentados explicitamente; dados ainda disponíveis continuam visíveis quando a atualização falha, com indicação de programação anterior. Uma janela vazia confirmada não inventa programa atual. A atualização altera somente os nós do bloco de programação: não recria cards nem inicia reprodução.

Os campos `beforePlayback` e `fullscreen` são consumidos por `openPlayer`: a solicitação de tela cheia ocorre no clique autorizado, antes de aguardar a engine; descritores podem ser resolvidos durante o encerramento anterior; a mídia aguarda sua confirmação. `onWatch` é invocado durante o clique, após o início de `pause()`, com a promessa `stopped`. O chamador pode abrir sua superfície e solicitar fullscreen enquanto a ativação do usuário existe, mas deve aguardar essa promessa antes de carregar qualquer mídia.

O terceiro argumento opcional de `render(existing, dto, state)` recebe o estado de `HomeTVModel`. Carregamento, falha e histórico válido vazio mantêm a seção visível com uma mensagem própria. Uma falha conserva os cards do último DTO e mostra aviso compacto; não imprime mensagens internas da API. Atualização em andamento com cards disponíveis não ocupa outra faixa. `onRetry` é opcional e só executa a recuperação explícita (`model.ensure({force:true})`), sem timer novo ou repetição por renderização. A chamada antiga com dois argumentos continua válida.

## Lifecycle sem reprodução automática

Pedido de 16/10 posterior à revisão de cinco cards removeu a prévia. `HomeChannelShelf` não importa `HomeChannelPreview`, não cria `<video>` e não possui engine, autoplay ou STOP próprio. `sync()` e `pause()` preservam a interface com o proprietário; `pause()` devolve uma promessa já resolvida. A reprodução explícita pertence ao player principal e sua barreira de STOP.

`HomeChannelPreview`, em `previa.js`, permanece como módulo isolado e testado, sem instância na Home atual. Seu contrato anterior e as evidências históricas estão em [cinco cards](../../../docs/home-tv-five-cards-20261017.md); não confundir código disponível com reprodução ativa.

Fullscreen é pedido no clique autorizado. Uma flag compartilhada encerra a superfície temporária quando todas as aberturas concorrentes falham antes de criar um player. Ao criar o player, ele assume a superfície.

## Projeção privada e Realtime

`HomeTVModel`, de `tanstack-query.js`, recebe `{request, getScope, getRevision, isActive, isAvailable, onChange}`. Expõe `state: {data, loading, waiting, error}`, `ensure({force=false}={})`, `invalidate()`, `reset()` e `dispose()`. `ensure()` não recebe nenhum item ou parâmetro implícito: usa somente as dependências injetadas. `getScope` recebe o escopo privado da conta conectada, mesmo quando o bootstrap cloud ainda não terminou, e seleciona somente conta/geração/PIN/filtros de TV por `tvScope`; `isAvailable` informa separadamente se a RPC pode ser usada. Indisponibilidade mantém o último DTO da mesma conta e apresenta `waiting`, sem realizar requisições impossíveis. `onRetry` deve recuperar a conexão pelo bridge existente antes de chamar `ensure({force:true})`; o módulo não cria uma sessão de autenticação. `getRevision` deve depender apenas da publicação de TV e da revisão privada de canais. O transporte é `POST /api/tv/home` com `{hidden: [ids], hiddenItems: [ids]}`. `HomeTVServices`, de `services.js`, aplica prazo de6s (RPC backend5s, SQL3s) e valida o DTO. O modelo mantém a ordem da RPC e seu último DTO válido na mesma conta; não usa catálogo/favoritos como substituto nem persiste o resultado no armazenamento local.

TanStack usa `retry:0`, sem recarga por foco/reconexão própria. Renderizações não repetem uma falha durante30s; `Retry-After` maior conserva a espera. Não há timer de repetição após erro. Uma invalidação válida pode reagrupar leituras bem-sucedidas com intervalo mínimo de15s. `ensure({force:true})` corresponde à recuperação explícita; não antecipa uma pausa HTTP429. `reset()` descarta imediatamente o DTO e cancela leitores ao trocar conta ou preferências.

`HomeTVRealtime`, de `realtime.js`, recebe `{getCloud: () => cloudLibrary, onChange}`. `sync()` observa somente `public.user_tv_watch_versions` no cliente SDK já autenticado de `CloudLibrary`, com filtro de proprietário e confirmação de `provider_key/scope_hash`. O callback indica `revision`, `subscribed` ou `reconnect`; o chamador executa `model.invalidate()` e, se o Início estiver ativo, `model.ensure()`. O registro não contém canais, estatísticas ou payloads pessoais. `reset()`/`dispose()` removem apenas esse canal, sem criar/destruir Auth ou outra biblioteca. Cada época usa um tópico distinto porque a versão instalada do SDK reutiliza um tópico antigo enquanto seu unsubscribe ainda termina.

## Batimentos do player principal

`TVWatchHeartbeat`, de `watch-heartbeat.js`, recebe `{video, getPlayer, getScope, request, onUpdate, isAllowed}`. `video` deve ser o elemento/proxy do player principal, nunca o vídeo de prévia. `getPlayer()` devolve o player atual com `item`, `attempt` e disponibilidade `mediaReady`/`nativeSourceStarted` ou `hlsReady`. `isAllowed(item, player)` verifica catálogo/ocultações/conteúdo adulto; não deve depender de o vídeo estar tocando ou da visibilidade do documento, porque a transição para `playing:false` também precisa encerrar uma medição existente.

O módulo observa `playing` real, aguarda os handlers existentes concluírem o evento e envia `POST /api/tv/watch-heartbeat` com `{id, attempt, playing, hidden, hiddenItems}`. Somente após confirmação envia o próximo pulso em15s, sem pedidos simultâneos. `pause/waiting/stalled/ended/error`, documento oculto e `pagehide` enviam falso quando houve início confirmado ou pendente. Falso antes do primeiro verdadeiro não cria uma sessão. Uma pausa seguida rapidamente de retomada conserva a transição falsa na fila. Posição, duração, relógio e segundos do cliente nunca seguem para o servidor. Na volta de uma aba que continuou tocando, um `timeupdate` com avanço apenas comprova que o vídeo voltou a avançar; não calcula tempo assistido.

`stop()` encerra o timer e faz o pulso final como melhor esforço, com promessa que absorve falhas; a troca de mídia **não precisa aguardar** esse envio. O chamador o inicia antes de apagar o player/attempt. `reset()` aborta o leitor antigo e limpa conta/estado; `dispose()` também remove os listeners. `sync()` reconcilia o player atual. `confirmPlaying()` é chamado em `onActiveVideoPlaying`, inclusive quando a aplicação adota um vídeo que já estava tocando e a promoção não emite outro evento nativo. Exige player elegível, frame real com dimensões, dados prontos e posição finita; não calcula segundos. `recover()` libera explicitamente um circuito que falhou e aguarda um avanço real da mídia no mesmo attempt/escopo antes de enviar verdadeiro. Isso permite iniciar a medição quando o vídeo começou antes do bootstrap cloud. Uma pausa durante falha mantém a transição falsa obrigatória antes de retomar verdadeiro. HTTP409 de uma intenção já encerrada é silencioso, sem repetição automática. O backend decide elegibilidade da tentativa, rejeita `purpose:preview`, controla UUID/seq e mede intervalos. `onUpdate` somente invalida a projeção quando chega uma nova revisão.

A contagem é uma aproximação por batimentos. A primeira sessão começa em zero; falhas de rede e a disputa com o encerramento podem perder ou limitar o último trecho. Recuperar uma sessão incerta conserva os limites e a sequência da RPC atual, sem inventar precisão de milissegundos ou prometer que todo trecho desconhecido será zerado. Não há campo de reset, nova identidade de medição enviada pelo navegador ou mudança de reprodução para obter estatísticas.

A estatística final é melhor esforço; o STOP da mídia do player continua confirmado antes de outra fonte. A Home atual não abre prévia.

## Verificação

Em 16/10/2026 a regressão da faixa invisível foi coberta por testes sintéticos de indisponibilidade, recuperação, preservação do DTO, troca de conta e ordem exata da RPC. A validação visual e de reprodução permanece com o usuário. Esses testes não certificam autoplay, fullscreen ou latência real do provedor.

Na revisão de cinco cards de17/10 UTC, `tests/home-channel-shelf.test.mjs` cobre o destaque padrão/mais assistido, quatro recentes, ausência de promoção local, atualização somente do programa atual sem recriar os cards, estados de grade, filtros e clique com pedido síncrono de fullscreen/barreira de STOP. São fixtures DOM sem navegador, mídia ou prova audiovisual.

A migration `20261016054432_arkhen_private_tv_watch_home.sql` foi aplicada ao projeto autorizado. Readback do esquema confirmou RLS, tabelas privadas sem SELECT/INSERT/UPDATE autenticados, publicação apenas da revisão e RPCs sem EXECUTE anônimo. O servidor local foi reiniciado com as novas rotas. Isso confirma integração e esquema, não autoplay ou comportamento audiovisual, cuja validação permanece com o usuário.

A composição EPG vive em `programacao.js` (`HomeChannelPrograms`) e usa a instância `tvGuide` existente. O registro de ativação, testes e limites está em [cinco canais com programação](../../../docs/home-tv-five-cards-20261017.md).

Revisão atual: [abertura, qualidade e Home sem prévia](../../../docs/tv-playback-recovery-20261017.md). `catalogForProjection` reaproveita snapshot completo durante revalidação compartilhada; a RPC continua revalidando conta, publicação e filtros. Os prazos não foram aumentados. A revisão integrada teve 138 testes internos aprovados, sem navegador/mídia real.
