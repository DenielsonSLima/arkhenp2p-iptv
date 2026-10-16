# Canais do Início

Integração implementada em `web/app.js`, 16/10/2026. Este módulo apresenta a projeção privada da RPC; não calcula popularidade no navegador nem cria uma conexão com o provedor.

## Apresentação

`HomeChannelShelf`, de `visualizacao.js`, recebe o DTO `{mostWatchedId, items:[{item, reason}]}`. Mantém a ordem do servidor, até quatro IDs distintos, com um canal mais assistido e até três recentes. `reason` é `most-watched` ou `recent`. Não preenche posições ausentes com favoritos ou canais aleatórios. Somente o item marcado `most-watched` que corresponde a `mostWatchedId` recebe prévia.

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
  preview: {
    playbackURL: (item, {attempt, purpose}) => tv.playbackURL(item, {attempt, purpose}),
    beforeStart: async ({signal}) => {
      await pendingStop;
      if (signal.aborted || player) throw new DOMException('', 'AbortError');
    },
    stop: ({attempt, scope, reason}) => stopPreviewAttempt({attempt, scope, reason}),
    getConfig: () => playerTools.configFor('live'),
    readFailure: (item, options) => readPlaybackFailure(item, options),
  },
});
const section = homeTV.render(existingSection, homeTVModel.state.data || {}, homeTVModel.state);
container.append(section);
homeTV.sync();
```

Os nomes `beforePlayback` e `fullscreen` no exemplo são o contrato proposto para a integração central; precisam ser consumidos pelo chamador. `onWatch` é invocado durante o clique, após o início de `pause()`, com a promessa `stopped`. O chamador pode abrir sua superfície e solicitar fullscreen enquanto a ativação do usuário existe, mas deve aguardar essa promessa antes de resolver ou carregar qualquer fonte.

O terceiro argumento opcional de `render(existing, dto, state)` recebe o estado de `HomeTVModel`. Carregamento, falha e histórico válido vazio mantêm a seção visível com uma mensagem própria. Uma falha conserva os cards do último DTO; não imprime mensagens internas da API. `onRetry` é opcional e só executa a recuperação explícita (`model.ensure({force:true})`), sem timer novo ou repetição por renderização. A chamada antiga com dois argumentos continua válida.

## Transporte e encerramento

`HomeChannelPreview`, de `previa.js`, usa `createLiveAttempt`, `supportsNativeHLS` e `PreparedLiveVideo`, já usados pelo player. O callback `playbackURL` somente devolve a rota local autenticada `/api/play/live/<id>/index.m3u8?attempt=...`; não recebe ou guarda endereço privado do provedor. O callback `beforeStart` confirma que o encerramento anterior terminou e que o player principal continua inativo. O callback `stop` deve encerrar somente a tentativa capturada, com a mesma conta/escopo, e resolver somente após a confirmação do backend. Falha de STOP é preservada e impede outra prévia automática; uma nova chamada explícita de `pause()` pode repetir esse encerramento.

O chamador central deve iniciar `pause()` ao abrir qualquer player, navegar para outra tela, buscar, abrir detalhes/configurações, bloquear o PIN, trocar conta ou sair. Deve aguardar o encerramento antes de outra fonte; o módulo não pode impor essa barreira aos outros players sozinho. `sync()` reconcilia a disponibilidade após renderização/retorno. O módulo também encerra a prévia quando o documento fica oculto, no `pagehide` e quando o card sai da área visível. Uma alteração de escopo invalida imediatamente operações antigas; um callback STOP antigo não pode atuar sobre uma nova conta.

O wrapper `pause(reason, options)` preserva a chamada antiga e aceita `{retryStop:false}` para pausas automáticas do render/lifecycle. Assim, um STOP falho não é repetido a cada render fora do Início. O clique em um card e a abertura explícita do player podem repetir o STOP retido. `isActive` deve excluir também uma abertura de player em andamento, inclusive enquanto ela aguarda a biblioteca de reprodução: um render de fundo não pode rearmar a prévia entre o clique e o início do player.

A prévia tem seu próprio `<video muted playsinline>`, sem controles de áudio, handlers de histórico, batimentos ou progresso do player principal. A sessão do provedor continua única. Não há pré-carregamento dos outros três canais, rotação, troca automática de fonte, tentativas extras após 401/403/429 ou tentativa de ligar uma engine Android.

`getScope` representa a identidade da sessão de reprodução (conta e geração de autenticação). Não deve incluir campos que aparecem depois do bootstrap cloud, como `project` ou `scopeHash`: o provisionamento cloud não troca a sessão de mídia. O callback URL recebe `purpose: 'preview'`; a integração deve propagá-lo à intenção autenticada para que o backend rejeite batimentos de prévia.

## Projeção privada e Realtime

`HomeTVModel`, de `tanstack-query.js`, recebe `{request, getScope, getRevision, isActive, onChange}`. Expõe `state: {data, loading, error}`, `ensure({force=false}={})`, `invalidate()`, `reset()` e `dispose()`. `ensure()` não recebe nenhum item ou parâmetro implícito: usa somente as dependências injetadas. `getScope` recebe o escopo privado da aplicação e seleciona somente conta/geração/PIN/filtros de TV por `tvScope`; `getRevision` deve depender apenas da publicação de TV e da revisão privada de canais. O transporte é `POST /api/tv/home` com `{hidden: [ids], hiddenItems: [ids]}`. `HomeTVServices`, de `services.js`, aplica prazo de6s (RPC backend5s, SQL3s) e valida o DTO. O modelo mantém a ordem da RPC e seu último DTO válido na mesma conta; não usa catálogo/favoritos como substituto nem persiste o resultado no armazenamento local.

TanStack usa `retry:0`, sem recarga por foco/reconexão própria. Renderizações não repetem uma falha durante30s; `Retry-After` maior conserva a espera. Não há timer de repetição após erro. Uma invalidação válida pode reagrupar leituras bem-sucedidas com intervalo mínimo de15s. `ensure({force:true})` corresponde à recuperação explícita; não antecipa uma pausa HTTP429. `reset()` descarta imediatamente o DTO e cancela leitores ao trocar conta ou preferências.

`HomeTVRealtime`, de `realtime.js`, recebe `{getCloud: () => cloudLibrary, onChange}`. `sync()` observa somente `public.user_tv_watch_versions` no cliente SDK já autenticado de `CloudLibrary`, com filtro de proprietário e confirmação de `provider_key/scope_hash`. O callback indica `revision`, `subscribed` ou `reconnect`; o chamador executa `model.invalidate()` e, se o Início estiver ativo, `model.ensure()`. O registro não contém canais, estatísticas ou payloads pessoais. `reset()`/`dispose()` removem apenas esse canal, sem criar/destruir Auth ou outra biblioteca. Cada época usa um tópico distinto porque a versão instalada do SDK reutiliza um tópico antigo enquanto seu unsubscribe ainda termina.

## Batimentos do player principal

`TVWatchHeartbeat`, de `watch-heartbeat.js`, recebe `{video, getPlayer, getScope, request, onUpdate, isAllowed}`. `video` deve ser o elemento/proxy do player principal, nunca o vídeo de prévia. `getPlayer()` devolve o player atual com `item`, `attempt` e disponibilidade `mediaReady`/`nativeSourceStarted` ou `hlsReady`. `isAllowed(item, player)` verifica catálogo/ocultações/conteúdo adulto; não deve depender de o vídeo estar tocando ou da visibilidade do documento, porque a transição para `playing:false` também precisa encerrar uma medição existente.

O módulo observa `playing` real, aguarda os handlers existentes concluírem o evento e envia `POST /api/tv/watch-heartbeat` com `{id, attempt, playing, hidden, hiddenItems}`. Somente após confirmação envia o próximo pulso em15s, sem pedidos simultâneos. `pause/waiting/stalled/ended/error`, documento oculto e `pagehide` enviam falso quando houve início confirmado ou pendente. Falso antes do primeiro verdadeiro não cria uma sessão. Uma pausa seguida rapidamente de retomada conserva a transição falsa na fila. Posição, duração, relógio e segundos do cliente nunca seguem para o servidor. Na volta de uma aba que continuou tocando, um `timeupdate` com avanço apenas comprova que o vídeo voltou a avançar; não calcula tempo assistido.

`stop()` encerra o timer e faz o pulso final como melhor esforço, com promessa que absorve falhas; a troca de mídia **não precisa aguardar** esse envio. O chamador o inicia antes de apagar o player/attempt. `reset()` aborta o leitor antigo e limpa conta/estado; `dispose()` também remove os listeners. `sync()` reconcilia o player atual. `confirmPlaying()` é chamado em `onActiveVideoPlaying`, inclusive quando a aplicação adota um vídeo que já estava tocando e a promoção não emite outro evento nativo. Exige player elegível, frame real com dimensões, dados prontos e posição finita; não calcula segundos. `recover()` libera explicitamente um circuito que falhou e aguarda um avanço real da mídia no mesmo attempt/escopo antes de enviar verdadeiro. Isso permite iniciar a medição quando o vídeo começou antes do bootstrap cloud. Uma pausa durante falha mantém a transição falsa obrigatória antes de retomar verdadeiro. HTTP409 de uma intenção já encerrada é silencioso, sem repetição automática. O backend decide elegibilidade da tentativa, rejeita `purpose:preview`, controla UUID/seq e mede intervalos. `onUpdate` somente invalida a projeção quando chega uma nova revisão.

A contagem é uma aproximação por batimentos. A primeira sessão começa em zero; falhas de rede e a disputa com o encerramento podem perder ou limitar o último trecho. Recuperar uma sessão incerta conserva os limites e a sequência da RPC atual, sem inventar precisão de milissegundos ou prometer que todo trecho desconhecido será zerado. Não há campo de reset, nova identidade de medição enviada pelo navegador ou mudança de reprodução para obter estatísticas.

Esses ciclos são diferentes: o STOP de **mídia da prévia** precisa ser confirmado antes de outra fonte, enquanto o batimento final **de estatística** é melhor esforço e não bloqueia a reprodução.

`preview.readFailure` tem assinatura `(item, {attempt, sourceId, mediaErrorCode, signal})`, igual à adaptação da continuidade do player. O item é o canal capturado, não o player global que pode já ter mudado. Deve consultar a rota local de status para esse ID/attempt e retornar `status.failure` (`null` explícito quando não há falha). Somente esse `null` permite uma troca de decoder nativo→HLS, uma vez, mantendo a mesma tentativa. Rejeição/retorno indefinido/erro do serviço encerra a prévia. A preparação exige a rota local de HLS autenticada; não sintetiza mídia para fontes incompatíveis. Sem suporte HLS/MSE ou quando o navegador recusa autoplay, o card mantém o logo e o acesso ao player.

## Verificação

Os arquivos podem passar por sintaxe/bundle estático. A autorização atual reserva testes, navegador e reprodução ao usuário. Essa inspeção não certifica autoplay, fullscreen ou latência real do provedor.

A migration `20261016054432_arkhen_private_tv_watch_home.sql` foi aplicada ao projeto autorizado. Readback do esquema confirmou RLS, tabelas privadas sem SELECT/INSERT/UPDATE autenticados, publicação apenas da revisão e RPCs sem EXECUTE anônimo. O servidor local foi reiniciado com as novas rotas. Isso confirma integração e esquema, não autoplay ou comportamento audiovisual, cuja validação permanece com o usuário.
