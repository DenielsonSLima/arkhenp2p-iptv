# TV ao vivo

## MEM-LIVE-028 — Metadados e relógio no rodapé

Estado: implementação local; inspeção/sintaxe, sem testes/navegador. Data:18/10/2026.

TV: número configurado, programa/canal, resolução medida e Hora HH:mm:ss; ranking não é medição, troca limpa dimensões. Relógio alinha segundos, suspende oculto e encerra com player. Centro/Agora amarelos. Grade antecipada uma vez; setas usam cache válido, refresh restrito. Fonte:[decisões e arquivos](../tv-player-metadata-clock-20261018.md).

## MEM-LIVE-027 — Cinco canais na Home e abertura de TV

Estado: código local ativado/testes sintéticos; SQL aplicada/readback anterior. Data:17/10/2026UTC.

Destaque semanal+até4recentes, Globo padrão sem histórico inventado; região/filtros preservados. Pedido posterior remove prévia: logo, borda branca, programa atual. Área3:2 logos conferida em cinco assets sem navegador. EPG até5IDs compartilhado; RPC revalida publicação/filtros/conta. Erro conserva cards e aviso.

Fontes coalescidas40s/STOP; parental reutiliza catálogo nativo sem cloud/login extra.39regressões; metadados reais5–6s frio,2–5ms repetição. Abertura fria/estabilidade Safari pendentes. Fontes:[revisão](../tv-playback-recovery-20261017.md), [descoberta](../tv-source-discovery-20261017.md), [SQL/rollout](../home-tv-five-cards-20261017.md). Versão remota21613 corresponde ao arquivo20723, SQL sem mudança.

## MEM-LIVE-026 — Destaque semanal da Home por intervalos datados

Estado: schema aplicado/readback confirmado. Data: 17/10/2026 UTC, 16/10 local.

Migration14445 usa168h exatas, buckets privados horários e interseção nas bordas; até169 buckets/canal. Limpeza limitada512 por batida, sem cron. Acumulado antigo não permite backfill semanal; recentes permanecem. Revalidação ativa após60s não cria polling. A seleção/apresentação seguinte está em027.

Fonte: [contrato e hashes](../home-movie-recovery-20261017.md). Substitui o cálculo vitalício de021.

## MEM-LIVE-025 — EPG por subconjunto e janela válida

Estado: SQL aplicada/readback informado; cliente local com33testes sintéticos, sem prova audiovisual. Data: 17/10/2026 UTC.

Migration20261017011816 filtra canais antes do lookup, mantém janela por revisão/fuso/fronteira e calcula progresso SQL sob demanda. Clock inativo; publicação e captura6h preservadas. Readback confirmou hashes/RLS/grants; CPU não certificada. Cliente une cards/favoritos/player/vizinhos. Revisão posterior preserva até2.000 janelas por ID em RAM/LRU, com validade do servidor, vazios autoritativos e limpeza por revisão/conta/PIN/epoch. Voltar à seleção válida não consulta novamente. Player prioriza janela compartilhada sobre DTO vazio da abertura. Não retoma catálogo durante vídeo, não persiste no disco nem calcula programa no cliente.

Fontes: [SQL/rollback](../tv-epg-on-demand-20261017.md), [cache por canal e limites](../tv-guide-memory-cache-20261017.md). Testes não certificam ativação Node/navegador.

## MEM-LIVE-024 — Publicação EPG primeiro

Estado: correção local e testes sintéticos; sem prova remota. Data: 16/10/2026.

O conector consultava WPLAY mesmo com RPC saudável. Agora prioriza snapshot fresco/completo; recuperação integral existente só começa se ausente/degradado ou após1s pendente. Isso não garante latência total nem deduplicação entre instâncias. Mantidos IDs, revisão da expansão24h, conta/PIN e coleta6h. APK baixa grade geral;30min é default DEX, não política remota medida. RPC/backend calcula programação; UI compartilha consulta. Timers padrão usam globalThis para preservar receptor. Removido plano TV obsoleto, atualizados testes legados e resumidas entradas históricas para caber no recuperador.

Fonte: [estratégia e validação](../epg-architecture-cleanup-20261016.md), [APK](../wplay/epg-apk-20261016.md). Evidência:1.085 testes aprovados e bundles ESM. Sem navegador, mídia, SQL remoto ou deploy.

## MEM-LIVE-023 — APK WPLAY: dados locais, versões e limites

Estado: engenharia reversa estática sem execução Android/login/mídia/teste. Data: 16/10/2026, extrações em 17/10 UTC.

Dossiê separa WPLAY 11.9.0d de BinStream 12.0.3 por hashes e inventários DEX/ELF. Extrações genéricas históricas de outra versão não validam corpos/offsets. No primário, catálogo HTTP tem cache manual apesar de NO_CACHE; EPG usa epg.data, mapa e LRU. Defaults DEX: live automático -1, EPG de 30 minutos, cache de 14 dias; TTL não é cadência. JNI/lifecycle protegido e conta efetiva permanecem lacunas. Busca literal negativa de Supabase não revela backend do fornecedor. Engines, decoder, offline e metadados são separados; nenhuma medição de RAM/tráfego ou recriação de ponte decorre disso.

Fonte: [dossiê e hashes canônicos](../engenharia-reversa-wplay-20261016/README.md). REA/JADX focado e leitura direta, sem executar alvo.

## MEM-LIVE-022 — Projeção incremental e cálculo por canal

Estado: histórico remoto com hashes conferidos, sucedido por MEM-LIVE-025. Data: 16/10/2026, readbacks em 17/10 UTC.

Migrations 20261017002040/20261017003830 reutilizam janelas até qualquer início/fim e calculam canais vencidos via LATERAL/PK, conservando empates, lacunas, fuso e DTO. Ainda regravavam progresso por minuto; etapa 025 elimina esse custo global. Reconstruções tiveram timeouts; não atribuir tempo a nó SQL nem certificar mídia por sucesso natural.

Fonte: [relatório e limites](../supabase-load-optimization-20261016.md), peer e readback. Sem teste, navegador ou reprodução nessa etapa.

## MEM-LIVE-010 — EPG sem bloqueio pelo bootstrap cloud

Estado: implementação local e leitura agregada histórica, sem prova audiovisual. Data: 16/10/2026.

`TvGuideProvider` reaproveita captura WPLAY por provedor/escopo por seis horas com token existente, sem login/engine por polling. Catálogo, `epgSameAs` antes de `chid`, PIN e geração filtram a projeção backend. Rotas mantêm status/expiração da conta. Uma leitura histórica confirmou programas na projeção legada; não usar suas contagens como estado atual.

Resposta parcial não substitui captura completa nem confirma ausência de canal. O publicador exige captura recente conforme seu contrato (15min na SQL inicial), podendo fazer um GET integral adicional; não baixa por canal. Fontes: [recuperação EPG](../tv-epg-recovery-20261016.md), `lib/tv/{grade-provedor,conector-supabase}.mjs`, `lib/wplay/ao-vivo/grade.mjs`, `lib/shared-cache-worker.mjs`.

## MEM-LIVE-007 — Backend modular de TV e limite do APK

Estado: contrato implementado localmente; inspeção/sintaxe/bundle estático, sem reprodução. Data: 16/10/2026.

`lib/tv/` passa a conter implementações de fontes, inventário WPLAY, associação web, transporte web por sessão e grade/EPG. `ConectorTvSupabase` concentra leituras/caches de programação e recebe dependências explícitas; não provisiona Auth, agenda coleta ou controla a engine. `CloudRuntime.epg/tvGuide` delegam ao conector. Fachadas antigas preservam os exports e apontam para a mesma implementação. Play/stop/status/proxy e o bridge genérico continuam compartilhados com VOD.

IDs de fonte/canal, autorização, cancelamento, intenção de abertura e STOP/sid/gen/429 foram preservados. TVBus, TVCarS e HTTP não são intercambiáveis. O APK do SHA conhecido foi inventariado com REA; a inspeção Android de classes ficou bloqueada pelo JAR JADX externo ausente. A evidência histórica de `sources[índice].address` não demonstra que o APK inicie na maior qualidade, nem que rótulo4K seja dimensão medida.

Fontes: [relatório de módulos e evidência](../tv-backend-modules-20261016.md), `lib/tv/conector-supabase.mjs`, `lib/wplay/ao-vivo/fontes.mjs`, `lib/wplay/ao-vivo/inventario-fontes.mjs`, `lib/wplay/ao-vivo/resolver-web.mjs`, `lib/wplay/ao-vivo/transporte-web.mjs`, `lib/cloud-runtime.mjs`.

## MEM-LIVE-001 — Sessão e identidade da fonte

Estado: contrato. Data: 15/10/2026.

Preferir HTTP real entregue pelo provedor. `tvbus://`, `tvcars://` e HTTP são contratos diferentes; APK não implica emulação Android obrigatória. Fontes alternativas pertencem ao mesmo canal comprovado; nome completo, número e região conservam significado. Stop/sid/generation e cancelamento impedem respostas antigas de reviver transmissão. Uma conexão tem uma reprodução ativa; EPG não controla esse ciclo.

Fontes: [contrato WPLAY](../wplay-playback-contract.md), `lib/live-playback-session.mjs`, `lib/wplay/ao-vivo/transporte-web.mjs`, [revisão local](../tv-home-recovery-20261015.md).

## MEM-LIVE-002 — EPG anterior e causa da nova etapa

Estado: histórico superado pelo guia em lote (MEM-LIVE-003/022). Data: 15/10/2026.

O código anterior misturava captura upstream e publicação em lotes; `epg_programs` recebia upserts sem reconciliação de remoções. Não restaurar esse caminho nem consultas por card para satisfazer testes antigos. Fonte: [guia global](../tv-guide-global.md), migration `20261015095103_arkhen_shared_metadata_set_based.sql` e histórico do coletor.

## MEM-LIVE-003 — Grade em lote e coleta separada

Estado: contrato; atualizações posteriores em MEM-LIVE-022. Data: 15/10/2026.

`/api/tv/guide` usa `arkhen_tv_guide` por provedor/partição/PIN/fuso e canais elegíveis. Snapshot completo e sanitizado é coletado separadamente da projeção temporal; consulta/tick não chama WPLAY. Falha preserva o snapshot anterior. A validade do guia não renova a autorização privada do coletor.

O DTO entrega revisão, relógio do servidor, próximo refresh, idade/horizonte e mapa por ID com anterior/atual/próximo, progresso e próxima mudança. Realtime acompanha registry compacto; não publica payloads grandes. Campos finais pertencem ao código atual, sem repetir inventário no corpus.

Fontes: [guia global](../tv-guide-global.md), migration `20261016022551_arkhen_tv_guide_snapshots.sql`, `lib/tv/conector-supabase.mjs`, `web/tv/tanstack-query.js`. Instalação, coleta e reprodução são evidências diferentes.

## MEM-LIVE-004 — Qualidade declarada, medida e automática

Estado: código local ativado e testes sintéticos; sem mídia/navegador. Data: 17/10/2026 UTC.

TV abre na maior fonte declarada/nível compatível. Quatro esperas em30s abrem aviso cancelável5s. Redução só no mesmoID; variantes de outroID são manuais. Navegação/pausa/seek/hidden/falha cancelam. Preferências restauradas não buscam nem desfazem redução. Atalhos modificados não sintonizam. Byte ranges normalizados sóTV; logs passivos limitados. `playing` exige vídeo pronto; erro atrasado/owner terminal não reabre. Nativo controla fontes expostas; ABR internoSafari sem API de nível. VOD isolado.

Fontes, testes e limites: [diagnóstico integrado](../tv-playback-recovery-20261017.md), `web/tv/player/qualidade-adaptativa.js`. Substitui ABR livre e default HD anteriores; não certifica início real em 3–4s.

## MEM-LIVE-005 — Publicação inicial parcial do guia

Estado: histórico; recusa de deploy resolvida posteriormente em MEM-LIVE-006. Data: 15/10/2026 local, 16/10 UTC.

A migration `20261016022551` teve readback após timeout de aplicação; não foi reenviada. Registry/RLS/staging foram confirmados, mas a primeira leitura ainda era legada, sem nova captura completa. A recusa inicial403 de Edge não descreve o estado posterior. `serverTime` precisa ser renovado na resposta sem alterar `asOf`.

Fonte: [registro do guia global](../tv-guide-global.md). Contagens/saúde dessa leitura não certificam o estado remoto atual.

## MEM-LIVE-006 — Publicação Edge inicial

Estado: histórico de publicação, sem prova de coleta ou mídia. Data: 16/10/2026.

Readback administrativo confirmou `arkhen-backend` e `arkhen-catalog-sync` ACTIVE/v9, resolvendo a recusa anterior. Versões posteriores pertencem ao [relatório de carga](../supabase-load-optimization-20261016.md). Deploy não prova job concluído; coleta exige fonte autorizada vigente.

Fonte: [registro do guia global](../tv-guide-global.md), `supabase/functions/arkhen-catalog-sync/epg-collector.mjs`.

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

## MEM-LIVE-014 — Programação posterior ao próximo

Estado: implementação local, sem prova visual. Data: 16/10/2026.

A RPC projeta anterior/atual/próximo; a UI aceita até128 eventos em `schedule`. O conector expande somente IDs autorizados, em lotes80, conferindo registry antes/depois e mesma revisão/fetchedAt/expiry. Cache distingue IDs carregados de ausentes. Acrescenta schedule/afterNext sem substituir os slots/progresso da RPC; legado usa revisão/flags próprias. Captura parcial ou antiga não rebaixa uma completa/fresca.

Horizonte de apresentação24h, coleta compartilhada6h, expansão com espera inicial até120ms e retry curto enquanto pendente. Não é nova coleta por card. Fontes: `lib/tv/{grade-programacao-publicada,conector-supabase,grade-legada}.mjs`, `web/tv/canais/programacao.js`, [contrato do guia](../tv-guide-global.md). Backend precisa estar carregado pelo Node; compilação não certifica dados atuais.

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


## MEM-LIVE-018 — Origem da troca e limite anterior de continuidade

Estado: histórico; limite de implementação superado por MEM-LIVE-020. Data: 16/10/2026.

Zap/número usam abertura padrão; somente prévia lateral confirmada usa preparação/barra discreta. Prévia sem confirmação não abre fonte. A análise anterior concluiu que transferMedia/clone/primeiro fragmento não certificam standby decodificado; a continuidade posterior usa dois elementos locais com migração explícita e buffer finito.

Fontes: `web/tv/player/navegacao.js`, `web/player/orquestrador.js`, `web/app.js`, [continuidade](../../web/player/troca-canal/continuidade/README.md). Sem prova audiovisual nesta análise.

## MEM-LIVE-019 — Armazenamento para zapping

Estado: histórico de análise, complementado por MEM-LIVE-020. Data: 16/10/2026.

Buffer local finito é preferível a Storage para poucos segundos. Storage não elimina captura, limite de fontes ou migração de vídeo; atualizar vizinhos exige recebê-los. Primeiro fragmento não prova quadro decodificado. Fonte: [análise de continuidade](../tv-player-continuity-options-20261016.md). Sem mídia real.

## MEM-LIVE-020 — Continuidade com dois vídeos locais

Estado: implementação local; evidência estática. Data: 16/10/2026.

Confirmação lateral usa standby silencioso após STOP; adota elemento/HLS/attempt pronto, migra controles/áudio e preserva buffer antigo finito/último quadro. Cancelamento enfileira STOP. Uma fonte remota, sem EPG/ETA calculados, cache Supabase ou reinício. Substitui o limite de implementação de018/019.

Fonte: [contrato](../../web/player/troca-canal/continuidade/README.md). Quatro agentes; sintaxe/bundle. Sem testes, navegador ou mídia. APIs gratuitas na [análise](../tv-player-continuity-options-20261016.md).

## MEM-LIVE-021 — Quatro canais privados da Home

Estado: implementação e readback históricos, sucedidos por026/027. Data: 16/10/2026.

Módulo lista-canais e lib/tv/home-* usam RPC privada, JWT/socket existentes e revisão por proprietário sem transmitir histórico. Heartbeat exige playing real da intenção principal, nunca preview/adulto; backend mede com relógio próprio, lease/seq e crédito máximo20s. Prévia tem STOP confirmado antes da próxima fonte; estatística final é melhor esforço. RLS/ACL foram conferidos; isso não comprova mídia.

Fontes: [contrato](../../web/inicio/lista-canais/README.md), [backend](../tv-home-backend-20261016.md), migration20261016054432.
