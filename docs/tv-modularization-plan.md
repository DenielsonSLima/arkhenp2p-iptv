# Modularização da TV

Este é o plano histórico anterior à extração. A implementação integrada e seus limites estão no [mapa final de16/10](tv-modularization-20261016.md).

Data: 2026-10-16. Evidência: leitura estática do código local; plano de extração, não certificação de execução ou estado remoto. As instruções do usuário prevalecem. Este documento não altera código.

## Limites preservados

O `web/app.js` continua dono da sessão, da geração de conexão, do repositório de catálogo compartilhado e do ciclo único de mídia. TV recebe essas dependências por referência. Não cria outro cliente Supabase/Auth, outro repositório global, nem uma conexão de reprodução concorrente. Filmes e Séries mantêm suas rotas, estado e controles compartilhados.

O servidor fica em `lib/tv/`, fora da raiz pública `web/`. URLs privadas, credenciais, autorização parental, JWT e clientes do provedor continuam no servidor. Descritores públicos de fonte contêm identidade e qualidade, sem URL privada. O escopo de guia inclui provedor/conta, geração, autorização adulta e fuso; trocar conta ou bloqueio invalida os dados correspondentes.

## Extrações concretas

| Destino proposto | Código existente a reunir | Responsabilidade e limite |
| --- | --- | --- |
| `web/tv/orchestrator.js` | Instâncias de `TVGuideClient`, `ChannelGuide`, `LiveProgramFeed`, `createLiveView` e `DailyGames` em `web/app.js` | Montar/desmontar TV, coordenar programação e jogos conforme categoria/visibilidade, invalidar/resetar e expor a mesma referência de guia ao player. Não conectar/desconectar conta nem carregar Filmes/Séries. |
| `web/tv/services.js` | Chamadas de guia, fontes e jogos feitas pela TV | Usar o `request` injetado para `/api/tv/guide`, `/api/live/sources` e a rota existente de jogos. Manter `AbortSignal`, geração e erros de autorização. O catálogo continua no `CatalogRepository` existente. |
| `web/tv/query.js` | `web/tv-guide-client.js` | Reaproveitar o cache, deduplicação e agendamento já existentes. Um `TVGuideClient`/`QueryClient` por instância de TV, compartilhado entre cartões, grade e player; não criar um por canal. Conservar a identidade da função `request`, usada pelo compartilhamento atual. |
| `web/tv/realtime.js` | Tratamento de `epg_cache_versions` e atualização do catálogo live em `web/app.js` | Consumir eventos da assinatura já mantida por `CloudLibrary`/`SharedCatalogUpdates`; invalidar somente TV. Receber evento compacto e refazer uma consulta em lote, sem assinatura ou request por canal. |
| `web/tv/channels.js` e `web/tv/list.js` | `LiveFeature`, `createLiveView`, montagem de cartões, seleção de canais numerados | Separar seleção/ordenação de canais e renderização da lista. Usar o catálogo live e as preferências existentes. Preservar IDs, numeração, categoria, bloqueio adulto e navegação do player. |
| `web/tv/programming.js` | `ChannelGuide`, `LiveProgramFeed`, `DailyGames` | Grade, programa anterior/atual/próximo e jogos; consumir `window` e progresso do DTO do servidor. Jogos só consultam quando a seção estiver visível. Não buscar EPG do provedor a cada leitura/minuto. |
| `web/tv/favorites.js` | Projeção live de favoritos e callbacks compartilhados de biblioteca | Selecionar canais favoritos e encaminhar a mutação à biblioteca pessoal existente. Não criar um segundo armazenamento ou uma identidade de conta específica da TV. |
| `web/tv/resolutions.js` | Métodos live de `PlayerTools` e `web/live-source-quality.js` | Escolher fonte do mesmo canal e níveis HLS reais, distinguir qualidade declarada e dimensões medidas. Preservar modo manual, estado adaptativo e limite de fallback. Não mover os controles de qualidade VOD. |
| `web/tv/buffer.js` | Perfil live de `PlayerTools.configFor`/`bufferConfig` e recuperação live existente | Concentrar configuração live e decisões de recuperação, mantendo uma única instância HLS e o bloqueio de 401/403/429/STOP. O backoff de transporte compartilhado continua no servidor. |
| `web/tv/audio.js` e `web/tv/subtitles.js` | Operações live de trilhas em `PlayerTools`, `AudioProcessing` e layout de legenda | Extrair operações reais de seleção/renderização quando houver código a mover. Compartilhar o mesmo vídeo, processamento de áudio e preferências atuais; não duplicar `MediaElementSource` ou controles VOD. |
| `web/tv/artwork.js` | `loadChannelLogos`, decoração de canal e `player-channel-logos` | Carregar uma vez o manifesto local e resolver imagens por identidade. Ícones de categorias do APK precisam de mapeamento verificável separado; não atribuir imagens por semelhança arbitrária de nomes. |
| `lib/tv/routes.mjs` | Ramos live de fontes, guia e jogos em `lib/app-server.mjs` | Reconhecer somente essas rotas e delegar aos serviços. Preservar validação de IDs, leitor abortável, autorização parental e conferência de geração após cada `await`. |
| `lib/tv/service.mjs` | Composição de `client.liveSources`, guia e jogos existente | Receber `state`, cliente do provedor e `CloudRuntime`; não reconstruir autenticação ou outro cliente do provedor. Retornar os DTOs existentes. |
| `lib/tv/supabase.mjs` | Adaptador de TV para `CloudRuntime.tvGuide`/`tv-guide-runtime.mjs` | Reutilizar JWT, cache e RPC do runtime atual. Consultar metadados públicos autorizados; coleta e publicação permanecem globais por provedor/escopo, não por usuário. |

Os nomes representam destinos, não a exigência de arquivos vazios. `web/tv/supabase.js`, se solicitado como fachada pública, só deve existir quando concentrar uma operação concreta de dados de TV. Não pode conter chave privilegiada, criar outro GoTrueClient ou duplicar `services.js` sem função própria.

## Fachada inicial para integração

Proposta implementável com os módulos existentes:

```js
const tv = createTVOrchestrator({
  request: api,
  getScope, getGeneration, getCatalog, getVisibleChannels,
  onWatch, onToggleFavorite,
  viewDependencies,
});

tv.guide;                       // a mesma instância entregue ao player
tv.createCard(item);
tv.mountCard(card, item);
tv.setVisibility({ visible, category });
tv.preparePlayback(item, { signal }); // fontes sanitizadas + programação inicial
tv.startProgram(item, { initialData });
tv.stopProgram();
tv.onSharedUpdate(event);
tv.onLibraryChange(changes);
tv.reset();
tv.dispose();
```

`preparePlayback` não inicia mídia. `openPlayer` mantém o gesto do usuário, intent, serial, seleção da fonte e montagem HLS/nativa compartilhados. `stopPlayback` continua central e chama `tv.stopProgram()` antes de destruir a mídia. `reset` encerra timers/observadores e invalida a geração, sem resetar catálogos VOD. A lista de canais entregue ao player deve usar a seleção já filtrada, numerada e autorizada, não o catálogo bruto.

No servidor, a fachada pode ser `handleTVRoute(req, res, url, context) -> Promise<boolean>`, em que `context` fornece estado, cliente, resposta JSON, runtime e os mecanismos atuais de autorização/abort. Retornar `false` para rotas não pertencentes à TV permite manter o dispatcher existente. A reserva de intent e os endpoints compartilhados de play/stop/status/proxy não devem migrar junto com fontes/guia.

## Ordem sugerida

1. Extrair o orquestrador web e as rotas específicas do servidor com as APIs existentes; reduzir o `app.js` a chamadas de ciclo de vida e renderização.
2. Mover seleção/lista/programação/favoritos e separar os métodos live de qualidade/buffer/trilhas que tenham responsabilidade real. Manter adaptadores de importação quando necessário para não quebrar consumidores atuais.
3. Consolidar dados de TV em query/realtime/serviços e assets em manifestos, sem trocar o mecanismo de cache, autenticação ou contrato de transporte durante a extração.

Fontes locais: `web/app.js`, `web/features/live.js`, `web/tv-guide-client.js`, `web/channel-guide.js`, `web/program-guide.js`, `web/live-view.js`, `web/daily-games.js`, `web/player-tools.js`, `web/channel-artwork.js`, `lib/app-server.mjs`, `lib/cloud-runtime.mjs` e `lib/tv-guide-runtime.mjs`. Aplicam-se `AGENTS.md` e as skills do repositório `arkhen-memory-rag`, `arkhen-senior-engineering`, `arkhen-iptv` e `arkhen-p2p`.

## Revisão dos módulos extraídos

Data: 2026-10-16. Estado: correções locais em implementação; conferência estática, sem teste funcional, navegador ou reprodução.

- `TVServices` remove imediatamente jobs cujo último leitor abortou e propaga reset aos leitores. Uma abertura seguinte não adere ao transporte já cancelado; resultados antigos continuam bloqueados por escopo/época.
- `TVFavorites` reconcilia o snapshot após salvar e libera o override concluído diante de registro remoto mais recente, inclusive tombstone. Escritas ainda pendentes conservam a intenção mais recente. A fila informada ao chamador é conferida no outbox existente, não inferida de qualquer falha.
- `TVChannelList` resolve favoritos a partir da biblioteca privada mesmo sem cobertura no catálogo parcial, reutilizando `resolveLibraryItem`. Não considera a prévia do catálogo como autoridade de exclusão do favorito.
- Atualização Realtime usa `load({revalidate:true})` → `loadCatalog('live',false,{revalidate:true})`: reler publicação não solicita coleta via `force`/`refresh=1`. Um evento recebido durante leitura agenda uma releitura coalescida. O callback do orquestrador deve preservar esse terceiro argumento.
- As chaves Query de favoritos/fontes incluem o escopo completo. Se uma consulta de guia terminar depois de mudar o escopo, o estado antigo é descartado antes de notificar os consumidores. A identidade Supabase é conferida também por projeto/provedor.

Limite: sem `cloud.scope` ou `offlineScope` previamente validado, a alteração fica no mapa local e não pode alegar uma fila remota durável. Uma remoção anterior ao primeiro bootstrap precisa de retomada pela biblioteca compartilhada após autenticação; esta extração não cria outra identidade ou outbox para fazê-lo.
