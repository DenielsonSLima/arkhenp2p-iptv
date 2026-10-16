# TV ao vivo

## MEM-LIVE-010 — Recuperação EPG sem dependência do bootstrap cloud

Estado: implementação local e leitura remota agregada; sem execução da recuperação na sessão real. Data: 16/10/2026.

O conector anterior exigia JWT cloud até para metadados EPG e as duas rotas usavam somente a projeção central. `TvGuideProvider` agora compartilha uma captura completa WPLAY por provedor/escopo durante seis horas, usando o token existente, sem `connect()`/login/engine. Catálogo da conta, `epgSameAs` antes de `chid`, PIN e geração Auth filtram a projeção backend. O guard das duas rotas EPG conserva a validação de status/expiração/24h e não renova login por polling.

Leitura remota de 16/10 às 03:55:22 UTC confirmou projeção sem adulto com 659 canais/565 programas atuais, apesar de o registry continuar legado e sem primeira captura nova. Portanto, banco sem snapshot novo não equivale a banco sem programação; falha de entrega/estado de UI deve ser investigada separadamente. As contagens são históricas, não limites fixos.

Parse parcial não certifica captura completa, não substitui snapshot anterior íntegro e não transforma canal ausente em lista vazia confirmada. Worker usa um arquivo integral recente por job WPLAY; o limite SQL de 15min impede reutilizar para publicação uma captura de leitor com seis horas. Um GET adicional do publicador permanece possível, sem N+1 por canal ou timestamp artificial. Nenhuma tabela, RLS, migration ou infra remota foi alterada.

Fonte: [causa, leituras agregadas, interfaces e limites](../tv-epg-recovery-20261016.md), `lib/tv/grade-provedor.mjs`, `lib/tv/conector-supabase.mjs`, `lib/wplay-epg.mjs`, `lib/shared-cache-worker.mjs` e integração EPG de `lib/app-server.mjs`. Verificação: sintaxe e bundle estático, sem testes, navegador, requisição WPLAY, reprodução ou restart.

## MEM-LIVE-007 — Backend modular de TV e limite do APK

Estado: contrato implementado localmente; inspeção/sintaxe/bundle estático, sem reprodução. Data: 16/10/2026.

`lib/tv/` passa a conter implementações de fontes, inventário WPLAY, associação web, transporte web por sessão e grade/EPG. `ConectorTvSupabase` concentra leituras/caches de programação e recebe dependências explícitas; não provisiona Auth, agenda coleta ou controla a engine. `CloudRuntime.epg/tvGuide` delegam ao conector. Fachadas antigas preservam os exports e apontam para a mesma implementação. Play/stop/status/proxy e o bridge genérico continuam compartilhados com VOD.

IDs de fonte/canal, autorização, cancelamento, intenção de abertura e STOP/sid/gen/429 foram preservados. TVBus, TVCarS e HTTP não são intercambiáveis. O APK do SHA conhecido foi inventariado com REA; a inspeção Android de classes ficou bloqueada pelo JAR JADX externo ausente. A evidência histórica de `sources[índice].address` não demonstra que o APK inicie na maior qualidade, nem que rótulo4K seja dimensão medida.

Fontes: [relatório de módulos e evidência](../tv-backend-modules-20261016.md), `lib/tv/conector-supabase.mjs`, `lib/tv/fontes.mjs`, `lib/tv/inventario-fontes-wplay.mjs`, `lib/tv/resolver-web.mjs`, `lib/tv/transporte-web.mjs`, `lib/cloud-runtime.mjs`.

## MEM-LIVE-001 — Sessão e identidade da fonte

Estado: contrato. Data: 15/10/2026.

Preferir HTTP real entregue pelo provedor. `tvbus://`, `tvcars://` e HTTP são contratos diferentes; APK não implica emulação Android obrigatória. Fontes alternativas pertencem ao mesmo canal comprovado; nome completo, número e região conservam significado. Stop/sid/generation e cancelamento impedem respostas antigas de reviver transmissão. Uma conexão tem uma reprodução ativa; EPG não controla esse ciclo.

Fontes: [contrato WPLAY](../wplay-playback-contract.md), `lib/live-playback-session.mjs`, `lib/wplay-web-playback.mjs`, [revisão local](../tv-home-recovery-20261015.md).

## MEM-LIVE-002 — EPG anterior e causa da nova etapa

Estado: evidência do código anterior à integração desta etapa. Data: 15/10/2026.

`SharedLiveEPG` coalescia leituras por escopo em lotes de até 80 IDs; o fallback WPLAY reaproveitava guia global por sessão durante cinco minutos. O coletor Edge baixava EPG antes de ler `epgDone`, publicava lotes visíveis e buscava novamente após yield. Isso permite misturar épocas upstream. `epg_programs` recebia upserts sem reconciliar remoções; não é uma fonte segura para a nova projeção sem corrigir essa semântica.

Fontes: `lib/shared-live-epg.mjs`, `lib/wplay-epg.mjs`, `supabase/functions/arkhen-catalog-sync/collector.mjs`, `supabase/migrations/20261015095103_arkhen_shared_metadata_set_based.sql`. Reconfirmar o código atual, pois a substituição está em andamento.

## MEM-LIVE-003 — Grade em lote e coleta separada

Estado: contrato em implementação; publicação parcial do banco registrada em MEM-LIVE-005. Data: 15/10/2026.

Integração planejada: `/api/tv/guide` → `cloudRuntime.tvGuide(state,{ids,includeAdult,timeZone})` → `arkhen_tv_guide(p_provider_key,p_scope_hash,p_channel_ids,p_include_adult,p_time_zone)`. O lote contém somente canais elegíveis do catálogo publicado; 659 seguros de 760 totais foi uma observação histórica, nunca um limite fixo.

A implementação de backend nesta rodada usa candidato privado sanitizado/selado em `arkhen_private.epg_snapshot_candidates`, registry compacto/RLS `public.epg_cache_versions` e projeção compartilhada por escopo, adulto, fuso e minuto em `arkhen_private.epg_projection_cache`. Coleta de seis horas é distinta da projeção por minuto: leitura/tick não chama WPLAY. Snapshot anterior permanece durante falha. Fonte privada expirada não é renovada pela validade do guia; publicação de candidato completo deve prescindir de novo fetch.

DTO combinado nesta etapa: `schemaVersion`, `revision`, `projectionVersion`, `asOf`, `serverTime`, `nextRefreshAt`, `sourceNextRefreshAt`, `snapshotFetchedAt`, `snapshotExpiresAt`, `horizonEnd`, `stale`; `channels[id]` possui `list` limitada a três, `window:{previous,current,next}`, `progressPercent`, `elapsedSeconds`, `remainingSeconds`, `nextChangeAt` e `status`. Confirme nomes finais no código antes de consumir. Realtime acompanha registry, não payloads da grade.

Fonte de implementação: `supabase/migrations/20261016022551_arkhen_tv_guide_snapshots.sql` e integração de `lib/cloud-runtime.mjs`. Arquivo local não comprova integração Edge ou coleta concluída; a evidência remota específica está em MEM-LIVE-005.

## MEM-LIVE-004 — Qualidade declarada, medida e automática

Estado: contrato em implementação nesta rodada. Data: 15/10/2026.

Descritores de fonte expostos à UI: `{id,label,quality?,declaredHeight?,bitrateBps?,videoCodec?,available}`; não contêm URL. Manter fontes disponíveis de qualidade desconhecida, distinguir declaração do provedor de `videoWidth/videoHeight` observados e preservar seleção manual. Automática inicia pelo maior nível realmente declarado em `hls.levels`, usando índice válido e mantendo ABR ativo; não inventar resolução ou usar `Infinity` como índice.

Troca automática entre fontes exige mesma identidade de canal, orçamento limitado e proteção contra fontes já visitadas. 401, 403, 429 e falha de parada não autorizam percorrer alternativas. A integração final depende dos módulos de player e transporte desta rodada; não há certificação de reprodução real nesta memória.

Fontes: `web/player-tools.js`, `web/adaptive-quality.js`, [API HLS.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md), [contrato WPLAY](../wplay-playback-contract.md).

## MEM-LIVE-005 — Publicação parcial do guia global

Estado: histórico de aplicação e leitura remota, sem certificação da integração completa. Data: 15/10/2026 local; conferência às 02:27:49 UTC de 16/10.

A migration EPG foi registrada remotamente como `20261016022551`. Uma chamada de aplicação excedeu o deadline HTTP de30s; o readback confirmou schema/histórico, sem reenviar DDL. A conferência confirmou RLS, RPC exclusiva do servidor, registry autenticado, staging privado, remoção dos payloads grandes da publicação Realtime e cron de projeção ativo. A cadência configurada passou a21.600s.

O corte conserva os caches anteriores em revisão explicitamente legada e desatualizada, com horizonte nulo e zero programas certificados como captura nova. A leitura observou760 canais legados, nenhum manifesto novo e nenhuma fonte cifrada vigente. Essas contagens são observações datadas; não comprovam uma primeira coleta completa.

Deploy de `arkhen-backend`/`arkhen-catalog-sync` recusado com403 por ausência de `edge_functions_write` na credencial administrativa atual; sessãoCLI alternativa inválida. Não houve nova versão Edge confirmada. A integração depende de credencial autorizada para deploy e fonte WPLAY válida. `serverTime` deve ser renovado a cada resposta, preservando `asOf`, para o cliente não atrasar boundaries ao receber cache antigo.

Fontes: [registro do guia global](../tv-guide-global.md), `supabase/migrations/20261016022551_arkhen_tv_guide_snapshots.sql`, `lib/tv-guide-runtime.mjs`. Sem testes, navegador, reprodução ou reinício nesta etapa.

## MEM-LIVE-006 — Publicação Edge do guia global

Estado: histórico de publicação remota confirmada; sem certificação da coleta ou reprodução. Data: 16/10/2026.

Às 03:03:46 UTC, a Management API confirmou `arkhen-backend` e `arkhen-catalog-sync` como `ACTIVE`, versão9, atualizados às 03:03:24.934 UTC no projeto autorizado. A credencial CI específica de Edge resolveu a recusa de permissão registrada em MEM-LIVE-005; a credencial SQL não foi alterada. Não houve teste, UI, playback ou nova escrita SQL nesta etapa.

Publicação de código não confirma execução de job nem leitura da biblioteca entre aparelhos. A ausência de fonte cifrada limita o coletor Edge; não prova impedimento da RPC de serviço direta nem do worker local autenticado. Esses caminhos devem ser diagnosticados separadamente.

Fontes: [registro do guia global](../tv-guide-global.md), `supabase/functions/arkhen-backend/handler.mjs`, `supabase/functions/arkhen-catalog-sync/epg-collector.mjs`. Evidência: retorno de deploy CLI e readback somente leitura de versões/timestamps/status pela Management API, sem payloads de contas.


## MEM-LIVE-008 — Orquestração isolada da TV

Estado: implementação local conferida estaticamente. Data:16/10/2026.

`web/tv/orquestrador.js` compõe uma instância de guia/query, serviços, adaptador
Supabase da biblioteca existente, Realtime, lista, favoritos, programação,
agenda e áudio. Resoluções, buffer e trilhas têm implementação TV própria.
`lib/tv/orquestrador.mjs` atende fontes/guide/epg/games depois da validação de
conta. Play/stop/status/proxy conservam uma reprodução compartilhada com VOD.

Eventos privados de favoritos/progresso não invalidam EPG. Realtime de catálogo
live relê o snapshot publicado com revalidate, sem refresh upstream e sem ser
interrompido pelo cache diário. Escopo TV inclui apenas preferências live e é
idempotente. Reset cancela leitores; mudança de conta/PIN rejeita retornos antigos.

Logos:202WebP preservados por hash,746IDs; a categoria não foi comprovada nas
consultas limitadas. Armazenamento em sem-categoria-verificada é explícito.
Filmes/Séries têm diretórios reservados, sem afirmar migração concluída.

Fontes: [mapa TV](../tv-modularization-20261016.md), [evidência APK](../tv-backend-modules-20261016.md),
`web/tv/`, `lib/tv/`, `web/app.js`, `web/player-tools.js`.
Verificação: sintaxe/bundle/diff e servidorHTTP200; sem reprodução ou confirmação
entre aparelhos. Não confundir publicação Edge deMEM-LIVE-006 com coleta nova.


## MEM-LIVE-009 — Inspeção atual do APK com JADX reparado

Estado: evidência estática do artefato, sem execução. Data:16/10/2026.

O bloqueio inicial deJADX registrado emMEM-LIVE-007 foi resolvido com o JAR
oficial0.7.1 em.local/tools, hash igual ao pin auditado doREA6.4.0 e configuração
apenas no processo. Inspeção atual:7.977 classes; ChannelBean.sources[],
SourcesBean/subTitle/backup/qualidade declarada e modelosEPG confirmados.
Métodos de seleção/EPG eTVCore.start(String) possuem flags public native0x101;
a falta de corpo Java não é ausência de ferramenta. Getters deSourcesBean
inspecionados têm DEX comum. Não foi demonstrada política inicial de maior
qualidade/ABR nem executadoAPK/mídia. A busca geralREA falhou por nome duplicado;
inspeções diretas funcionaram e preservaram IDs de evidência.

Fonte: [inspeção atual e proveniência](../tv-backend-modules-20261016.md).

## MEM-LIVE-011 — Minha lista em grade e ordenação dos favoritos

Estado: implementação local conferida por revisão e compilação estática. Data: 16/10/2026.

Minha lista mantém somente Ao vivo, Filmes e Séries; entrada antiga em `__all` abre Ao vivo. Os canais favoritos seguem a numeração de `SettingsTools`, também usada pelo player. A grade apresenta número, logo/canal, programa atual e próximo, usando somente `window`, horários e progresso da instância compartilhada de `TVGuideClient`. Não cria programação futura nem relógio ou consulta por canal. Filmes e Séries mantêm as capas e sua ordenação; o estado de carregamento considera o domínio da aba selecionada.

Em Configurações > TV ao vivo, editar um número ocupado troca os números dos dois canais em uma persistência. Arrastar, usar os botões subir/descer ou as setas no pegador move o canal e desloca os intermediários, conservando os números disponíveis da lista, intervalos e reservas externas. IDs e biblioteca pessoal não são recriados. A grade pausa a própria inscrição fora da aba, em configurações, páginas de conteúdo e documento oculto; reset de conta/PIN limpa suas linhas sem reiniciar a instância compartilhada do guia.

Fontes: `web/minha-lista/grade-tv.js`, `web/minha-lista/grade-tv.css`, `web/minha-lista/orquestrador.js`, `web/sistema/configuracoes/orquestrador.js`, `web/settings.css`, integração em `web/app.js` e `web/index.html`.
Evidência: revisão estática com três agentes, sintaxe Node e compilação JavaScript/análise CSS em memória. Sem testes, navegador, reprodução ou publicação remota nesta etapa; aparência e interação no navegador ainda não verificadas.

## MEM-LIVE-012 — Linha do tempo da programação em Minha lista

Estado: implementação local histórica, substituída visualmente por MEM-LIVE-013/017. Data: 16/10/2026.

A grade passou a usar eixo absoluto compartilhado, logos compactos, relógio/linha atual a partir de serverTime e tempo monotônico, sem selecionar programas ou calcular progresso local. Programas conservam início/fim reais e lacunas. A assinatura e o timer visual pausam fora da tela. Naquela etapa o eixo começava com seis horas, e schedule/afterNext complementavam o list legado. O limite posterior de entrega foi tratado em MEM-LIVE-014; o padrão de largura/rolagem atual está em MEM-LIVE-017.

Fontes: web/minha-lista/grade-tv.js, linha-tempo.js, grade-tv.css, web/tv/canais/programacao.js e [contrato do guia](../tv-guide-global.md). Evidência: revisão/compilação estática, sem testes, navegador ou mídia.

## MEM-LIVE-013 — Grade ajustada à tela e abertura sem corte automático

Estado: implementação local histórica; padrão de largura substituído por MEM-LIVE-017. Data: 16/10/2026.

A abertura cortava programas por chamar scrollToNow automaticamente. A criação passou a scrollLeft zero; atualizações não reposicionam a rolagem. O modo fit foi o padrão desta etapa, antes da expansão para 24h tornar o conteúdo ilegível e motivar MEM-LIVE-017. O eixo considera eventos recebidos, passado próximo limitado e próximas 24h; não inventa programação. Seleção mostra título completo no painel sem abrir vídeo; assistir permanece no botão do canal. Três agentes revisaram apresentação/contratos/entrega. Backend não mudou nesta etapa, e RPC básica ainda podia entregar só atual/próximo.

Fontes: web/minha-lista/grade-tv.js, linha-tempo.js, grade-tv.css e [contrato do guia](../tv-guide-global.md). Evidência estática, sem testes, navegador, rede, mídia ou reinício.

## MEM-LIVE-014 — Entrega da programação posterior ao próximo

Estado: implementação local, sem ativação remota ou verificação funcional. Data: 16/10/2026.

O limite observado na apresentação não se resolve apenas com zoom: a RPC antiga projeta somente anterior/atual/próximo a partir de `provider_epg_cache.payload.list`. O frontend já aceita `schedule` com até 128 eventos. O conector passa a ler as listas dos canais autorizados em lotes de 80, com registry antes/depois e mesma revisão/fetchedAt/expiry da RPC não legada, sem nova coleta por canal. Cache compartilhado limitado conserva somente metadados sanitizados e distingue IDs carregados de IDs ainda ausentes em outro escopo adulto.

Na captura certificada, preserva window/list/progresso/asOf e acrescenta schedule/afterNext da mesma revisão. A captura legada usa substituição inteira com revisão própria e flags de legado/obsolescência, whitelist de IDs e preservação de slots existentes. Uma alternativa precisa conter mais eventos reais, e não somente um array de dois programas. O horizonte projetado passa de seis para 24 horas, mantendo 128 eventos por canal e coleta compartilhada de seis horas. A espera adicional é de até 120 ms e há retry curto somente durante expansão pendente; fonte parcial/mais antiga não rebaixa captura completa e fresca.

Não houve mudança de layout nesta correção de entrega. `server.mjs` importa os módulos uma vez: refresh do navegador não aplica backend novo; shutdown/reinício limpa as sessões em memória. Sintaxe/bundle local não comprovam carregamento do código pelo processo ativo nem quantidade de programas na fonte atual.

Fontes: `lib/tv/grade-programacao-publicada.mjs`, `lib/tv/conector-supabase.mjs`, `lib/tv/grade-legada.mjs`, `supabase/migrations/20261016022551_arkhen_tv_guide_snapshots.sql`, `web/tv/canais/programacao.js`, `server.mjs`, `lib/app-server.mjs`, [contrato do guia](../tv-guide-global.md). Verificação limitada a inspeção e compilação estática; sem testes, navegador, consulta de dados remotos, alteração SQL ou deploy nesta etapa.

## MEM-LIVE-015 — Player modular e prévia independente do canal ativo

Estado: implementação local, sem prova funcional. Data: 16/10/2026.

UI canônica em web/player/ com controles/teclado separados e fachada compatível; grade, numeração, EPG e prévia por ID em web/tv/player/. Cima/baixo troca a partir do ativo; esquerda/direita percorre prévia e Enter/OK/clique confirma. Expiração4s cancela sem sintonizar. Rodapé segue vídeo ativo, campos/menus mantêm teclado, reset cancela timer/inscrição. ID prevalece sobre número reatribuído. Quatro agentes analisaram. Barra foi implementada depois em MEM-LIVE-016; modos corrigidos em MEM-LIVE-018. Pré-buffer dos vizinhos não existe, e Supabase mantém metadados.

Fontes: web/player/, web/tv/player/, web/app.js, [análise](../tv-player-navigation-20261016.md). Revisão/sintaxe/bundle, sem testes, navegador, mídia, reinício ou publicação.

## MEM-LIVE-016 — Barra modular e preparação da troca TV

Estado: implementação local, sem prova funcional. Data: 16/10/2026.

web/player/troca-canal/ separa visual/CSS, serviço e controlador. Barra indeterminada usa número, logo/nome, TVGuide.window.current e labels backend; sem EPG informa ausência. Não calcula programa/progresso/ETA. Consulta liveSources antes do STOP mantém o atual apenas na preparação de descritores. ID/escopo/PIN/visibilidade/referência ativa são revalidados; erro/abort pré-handoff não para o atual. Resultado consumido uma vez, sem ticket/preparo em retry; release libera referências e inscrição. sources:[] é válido. Após handoff, geração/STOP/sid continuam donos; cancelar UI não abandona abertura aceita. Fim em playing, falha/fechamento ou mídia pronta para play manual. Não mantém imagem antiga até novo quadro; MEM-LIVE-018 restringe barra à prévia confirmada.

Fontes: [contrato](../../web/player/troca-canal/README.md), web/app.js, web/tv/services.js, lib/tv/orquestrador.mjs. Quatro agentes; revisão/sintaxe/bundle, sem testes, navegador, mídia, rede ou restart. Backend não mudou; MEM-LIVE-014 aguarda ativação separada.

## MEM-LIVE-017 — Grade com rolagem e escala legível por padrão

Estado: implementação local, conferência estática. Data: 16/10/2026.

Com até24h, fit comprimia programas. Padrão agora Com rolagem:400px/h desktop,360px/h móvel; Ajustar à tela manual. Títulos/linhas maiores, palavras sem letras empilhadas; eventos curtos não alargados nem sobrepostos. A pedido posterior, grade cresce conforme canais SEM limite de altura/rolagem vertical interna: só a página rola verticalmente, lateral preservada. Identidades ficam fixas horizontalmente. Abertura scrollLeft zero, atualizações sem rolagem até relógio. Só apresentação mudou; backend define programas/horários.

Fontes: web/minha-lista/grade-tv.js, grade-tv.css e [contrato](../tv-guide-global.md). Revisão/sintaxe/bundle, sem testes, navegador, mídia, rede, restart ou alteração backend.


## MEM-LIVE-018 — Visual por origem da troca e limite da continuidade

Estado: correção local e análise de viabilidade, sem prova audiovisual. Data: 16/10/2026.

Origem percorre Navigation→ImmersivePlayer→app: zap (↑↓/Channel/Page) e número usam openPlayer padrão; só preview confirmado (←→/OK ou clique no cabeçalho lateral) usa preparação/barra discreta. Prévia sem confirmação não abre fonte. Corrige a aplicação anterior da barra a qualquer troca.

Continuidade de vídeo antigo até alvo decodificado NÃO está implementada. HLS1.6.13 stopLoad preserva buffer local finito, mas stopPlayback destrói MSE/src. transferMedia conserva o mesmo elemento e não promove buffer de standby. App/controles/WebAudio retêm vídeo fixo; continuidade real exige dois elementos e migração explícita de controles/áudio/eventos. Um upstream pode ser mantido drenando buffer antigo após STOP, mas não garante cobrir abertura. Pré-fetch de fragmento não prova quadro decodificado; HLS nativo não tem mecanismo equivalente no código atual. Não usar clone/captureStream/transfer como falsa solução.

Fontes: web/tv/player/navegacao.js, web/player/orquestrador.js, web/app.js, web/assets/vendor/hls.min.js, web/audio-processing.js e [limites](../../web/player/troca-canal/README.md). Revisão, sintaxe e bundle; sem testes, navegador, reprodução, rede ou reinício.

## MEM-LIVE-019 — Análise de armazenamento temporário para zapping

Estado: análise de código/documentação oficial, sem implementação de continuidade. Data: 16/10/2026.

Reunião recomenda buffer local e eventual RAM privada antes de Storage para poucos segundos. Provider já guarda segmentos até32MiB/60s, limpos no STOP; preservá-los exigiria namespace antigo sóleitura, sem acesso upstream. Supabase guarda arquivos, mas não elimina captura/limite de fontes nem migração dos dois vídeos locais. Janela5s renovada dos vizinhos continua exigindo recebê-los. Primeiro fragmento não comprova quadro pronto; buffer antigo é finito. Dois slots locais com uma fonte remota são desenho viável a investigar; garantia ilimitada depende de simultaneidade remota comprovada.

Fontes: [análise e fontes oficiais](../tv-player-continuity-options-20261016.md), lib/provider.mjs, lib/app-server.mjs, web/app.js. Sem mídia/rede da conta ou reinício.

## MEM-LIVE-020 — Continuidade com dois vídeos locais

Estado: implementação local; evidência estática. Data: 16/10/2026.

Confirmação lateral usa standby silencioso após STOP; adota elemento/HLS/attempt pronto, migra controles/áudio e preserva buffer antigo finito/último quadro. Cancelamento enfileira STOP. Uma fonte remota, sem EPG/ETA calculados, cache Supabase ou reinício. Substitui o limite de implementação de018/019.

Fonte: [contrato](../../web/player/troca-canal/continuidade/README.md). Quatro agentes; sintaxe/bundle. Sem testes, navegador ou mídia. APIs gratuitas na [análise](../tv-player-continuity-options-20261016.md).

## MEM-LIVE-021 — Quatro canais privados da Home e tempo por batimentos

Estado: implementação local revisada; commit SQL e readback de schema confirmados pelo integrador. Sem validação funcional da RPC ou reprodução. Data: 16/10/2026.

A faixa da Home pertence a `web/inicio/lista-canais/`: contrato, serviços, cache/query, Realtime, batimentos do player, visualização/CSS e prévia. O backend fica em `lib/tv/home-{request,conector-supabase,orquestrador}.mjs`, com `POST /api/tv/home` e `POST /api/tv/watch-heartbeat`. Reutiliza sessão/JWT, validação de conta, catálogo e socket Supabase existentes; não abre um SDK de autenticação nem coleta ou consulta fontes por canal para montar a faixa. A RPC Home de Filmes/Séries permanece independente.

`arkhen_home_tv` retorna `schemaVersion:1`, `source:'rpc'`, revisão privada, geração publicada, `mostWatchedId` e até quatro `items:{item,reason,watchedSeconds,lastWatchedAt}`. O banco escolhe um canal com tempo acumulado positivo e até três recentes distintos, excluindo o primeiro. Sem tempo positivo não há destaque nem prévia; podem existir apenas recentes. `user_progress` de TV, salvo pelo `playing` real com tempo zero, pode fornecer recência após validar dono/provedor, forma, tombstone e catálogo atual; posição/duração antigas nunca viram segundos. Não completar vagas com favoritos ou canais aleatórios. Catálogo ativo, disponibilidade da conta, ocultações e adulto de mídia/metadados/categorias são filtrados antes dos limites. PIN desbloqueado nunca permite adulto nesta faixa ou medição.

A migration `20261016054432_arkhen_private_tv_watch_home.sql` mantém tempo e lease em `arkhen_private`, com RLS e sem acesso direto autenticado. As RPCs derivam `auth.uid()` e validam a partição da conta; a única tabela publicada em Realtime é `public.user_tv_watch_versions`, com leitura apenas do proprietário e sem IDs de canal, duração ou payload. Eventos desse registro e progresso live legado invalidam somente a consulta dos quatro cards.

O wrapper confirmou COMMIT com retorno `[]`. Um readback somente de schema confirmou RLS nas três tabelas; tempo e sessões privados sem SELECT/INSERT/UPDATE autenticados e fora do Realtime; registry público com SELECT autenticado apenas, política de proprietário/partição e publicação Realtime. As duas RPCs são definer, com `search_path` vazio, limite SQL de3s, EXECUTE autenticado e recusa anônima; Home usa JIT desligado e heartbeat tem espera de lock limitada a500ms. Essa evidência confirma instalação e permissões, sem executar as RPCs privadas.

UUID e sequência dos batimentos pertencem ao backend, vinculados à intenção/attempt atual de finalidade `playback`; `preview` é recusada. O SQL usa seu relógio, sem posição, duração, timestamp ou segundos fornecidos pelo navegador. Primeiro batimento e retomada abrem medição com zero; intervalos anteriores de playing têm crédito máximo de20s, lacunas maiores que35s não são preenchidas. Lease serializado por proprietário/partição, sequência idempotente e sessões aposentadas impedem dupla contagem. Batimentos normais têm15s; pausa, espera, erro, parada ou documento oculto encerram o estado. Essa é medição pelo protocolo de eventos reais do player, não certificação audiovisual independente pelo banco.

Prévia só do destaque, em vídeo separado/silencioso e visível na Home. Não salva histórico nem emite batimentos. STOP confirmado precede uma nova fonte principal; tentativa antiga não pode parar a nova. O integrador concluiu as guardas apontadas na revisão: fechamento capturado no backend e ordenado antes de STOP/nova intenção, com orçamento de6s e falha de telemetria sem impedir o player; `confirmPlaying` na adoção de vídeo já tocando; prova de avanço ao recuperar o contexto cloud. A prévia não repete STOP automaticamente (`retryStop:false`), conserva contador de abertura e só inicia após a liberação do carregamento de entrada. São correções de integração local, sem alterar a fórmula SQL nem comprovar execução audiovisual.

Fontes: [contrato frontend](../../web/inicio/lista-canais/README.md), [backend](../tv-home-backend-20261016.md), migration citada, `web/app.js`, `lib/live-playback-session.mjs`; confirmação do integrador do COMMIT, readback e conclusão das guardas nesta rodada. Evidência: leitura de código, duas revisões independentes da SQL e conferência remota somente de schema. Sem execução funcional das RPCs, testes, navegador, mídia ou consulta de biblioteca pessoal nesta etapa.

Complemento operacional de MEM-LIVE-021 (16/10/2026): servidor local reiniciado em localhost:4173 mantendo a configuração existente da engine. Bundle estático JS/CSS, sintaxe e diff sem erros. Não houve teste automatizado, navegação ou reprodução pela equipe.
