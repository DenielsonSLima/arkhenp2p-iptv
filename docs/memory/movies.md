# Filmes

## MEM-MOVIES-012 — Home VOD independente da preparação de TV

Estado: RPCs aditivas publicadas e conferidas; rotas HTTP com login normal validadas; Safari pendente. Data: 17/10/2026.

`arkhen_home_vod` substitui o uso atual da HomeLibrary legada sem consultar catálogo, favoritos ou progresso de TV. Conserva ranking, históricos e contagens VOD; os campos legados de canais ficam vazios. `arkhen_home_tv_catalog` deriva os IDs autorizados da geração live no banco e chama a projeção TV já existente, evitando transferir o catálogo inteiro para obter cinco cards. Sugestões de um filme continuam exclusivamente em `arkhen_movie_recommendations`.

Fixture PostgreSQL reproduziu o acoplamento anterior: um canal sem `home_identity` fazia a Home inteira retornarNULL. O isolamento preservou a mesma ordenação VOD diante dessa falha.141 asserções passaram; readback confirmou hashes, ACL autenticada/invoker e prazos8s/3s. Houve57014 real na Home e indisponibilidade pontual dos três serviços, seguida de reinício externo observado; não atribuir a recuperação da infraestrutura às migrations nem declarar corrigida a latência de Filmes sem medir sua requisição real.

Fonte: [isolamento, publicação e limites](../home-recommendations-isolation-20261017.md), [pastas SQL por domínio](../../supabase/domains/README.md), migrations161601/161618.

Validação posterior em instância temporária: HomeTV200/550ms, HomeVOD200/2612ms e sugestões200/3213ms. Servidor4173ativado depois de172testes integrados; três rotas e revisões dos catálogos novamente200 com login normal. São amostras pontuais, sem certificação de latência contínua, reprodução ou interface. O cliente separa escopos TV/VOD/Filmes e preserva DTO válido do mesmo proprietário quando a atualização falha. Conferir relatório para a evidência final.

## MEM-MOVIES-011 — Compartilhar recomendações simultâneas sem cache privado

Estado: implementação local e inspeção estática; sem confirmação funcional ou publicação. Data: 17/10/2026 UTC (16/10 no fuso do produto).

O conector de Filmes compartilha somente a RPC idêntica ainda em andamento, isolada por estado/conta/cliente/autenticação/PIN/provedor/escopo/origem/limite/ocultações. Consumidores mantêm cancelamento independente; o último leitor cancela upstream, e encerrar o runtime aborta pendências. A conclusão remove o resultado do servidor, sem cache privado ou ranking alternativo. Os guards anteriores continuam sendo conferidos na entrega.

As imagens desta rodada mostram503 e falhas de identidade, mas não identificam a fase da requisição de Filmes. Sem código/duração atual, não repetir o diagnóstico antigo de timeout como causa confirmada. A última SQL local continua051752 com mapa por geração, franquia/universo pelo nome, gênero, categoria e nota como desempate; nenhuma migration ou prazo foi alterado nesta frente.

Fontes: `lib/filmes/conector-supabase.mjs`, [análise e limites](../movies-recommendations-single-flight-20261017.md), migration051752. Evidência: `node --check` e `git diff --check`; nenhum teste, navegador, chamada à aplicação, leitura privada ou reprodução.

## MEM-MOVIES-010 — Recuperação das capas de favoritos

Estado: implementação local e testes sintéticos; sem confirmação visual ou publicação. Data: 16/10/2026.

A hidratação anterior considerava somente histórico e seu callback de erro ignorava favoritos nunca assistidos. Minha Lista agora fornece sua janela visível preservando a ordem; a recuperação consulta detalhes em concorrência limitada e conserva conta/epoch/adulto. Hash autorizado com falha transitória de nuvem deve produzir 503; hash desconhecido continua bloqueado. A reconexão válida da mesma conta pode renovar uma vez o orçamento de tentativas, sem alimentar loop de render/imagem.

Fontes: `web/minha-lista/capas.js`, `web/minha-lista/orquestrador.js`, `web/library-artwork.js`, `web/artwork-image.js`, `web/app.js`, `lib/cloud-runtime.mjs`, `tests/library-artwork.test.mjs`, `tests/artwork-image.test.mjs`. Banco indisponível continua impedindo capas globais e recomendações; esta correção não prova recuperação remota.

## MEM-MOVIES-009 — Sugestões relacionadas e cards padronizados

Estado: usuário confirmou sugestões relacionadas e apresentação em imagem; implementação visual conferida no código local. Data: 16/10/2026.

As sugestões usam o mesmo `mediaCard` do catálogo, com capa, título, metadados e favorito, em vez de um card paralelo com proporções próprias. `MovieSuggestionsView` recebe esse construtor e conserva a ordem da RPC. A grade mostra até dez sugestões, cinco por linha no desktop e menos colunas conforme a largura disponível. Essa padronização visual não muda franquia/universo, ranking ou identidade, que continuam no banco.

A confirmação do usuário comprova que sugestões relacionadas chegaram naquela interação; não comprova latência de todas as requisições, estabilidade geral da Home ou reprodução. Falhas503 intermitentes continuam pendentes e sua investigação foi explicitamente adiada pelo usuário para priorizar a faixa de TV na Home. Não registrar503 como resolvido nem ampliar prazos por essa confirmação visual.

Fontes: confirmação e imagem do usuário transmitidas pelo integrador nesta rodada; `web/app.js` (`mediaCard`), `web/filmes/recomendacoes/visualizacao.js`, `web/movie-suggestions.css`, [evidências anteriores503](../movies-recommendations-503-20261016.md). Nenhum teste, navegador ou reprodução executado nesta atualização da memória.

## MEM-MOVIES-008 — Limite após ranking não limita o trabalho

Estado: causa posterior capturada e SQL publicada; resposta da sessão real pendente. Data:16/10/2026.

Após alinhar o HTTP para10s, novas requisições reais continuaram canceladas em cerca de8s com SQLSTATE57014 nas RPCs de Home e Filmes. A045808 limitava o resultado das fases, mas classificava e ordenava um catálogo amplo antes do LIMIT. GIN válido não comprova uso sob RLS quando operadores e funções não são LEAKPROOF. Manter RLS; preparar mapa editorial por geração no modelo global e limitar IDs antes de classificar. Home051017 limita expansões de grupos antes dos filtros; leitura de schema confirmada, latência da RPC não aferida. Não confundir a correção inicial de HTTP3s com resolução integral.

Fonte: [diagnóstico atualizado e evidências](../movies-recommendations-503-20261016.md), migration051017. Nenhuma biblioteca pessoal integra o mapa global.

Atualização:51752 e53123 publicadas e conferidas. Filmes consulta mapa por geração com grupos e byId; o preparador usa o GIN existente para selecionar positivos e o backfill só acrescenta o campo aos dois modelos atuais. A primeira aplicação falhou57014 e foi revertida inteira; a versão final foi aplicada com sucesso. Home53123 retira a busca de cada histórico nos arrays globais de gênero, usando campos compactos das linhas correntes. RLS e SQL8s preservados. A leitura global confirmou mapa completo da geração; não certifica a resposta privada nem a experiência visual.

## MEM-MOVIES-007 — 503 por prazo incompatível e ranking em fases

Estado: causa capturada na requisição real e correções publicadas; validação visual posterior pendente. Data:16/10/2026.

O processo local capturou Filmes/Home expirando em3002/3003ms com CLOUD_TIMEOUT na faseRPC. Estatísticas do banco registravam Filme concluído em6528ms eHome média4707ms/máximo7973ms. HTTP3s era menor que consultas reais e que o orçamento SQL8s. Corrigido somente Home/Filmes para HTTP10s e clienteFilmes12s; sem ampliar mídia. SQL otimizada com migrations045808/050044: ranking em fases e Home de candidatos compactos. Readback confirmou invoker/permissões/índices válidos; não houve alteração de biblioteca. Identidade2 adicionaLOTR/Hobbit e faz parte da chave de cache; ranking2 continua. Frontend permanece sem ranking local.

Fonte: [diagnóstico e rollout](../movies-recommendations-503-20261016.md), [SQL em fases](../movies-recommendations-performance-20261016.md). Estatísticas antigas não medem o ganho da nova SQL.

## MEM-MOVIES-005 — Organização completa do domínio

Estado: código local integrado e revisão estática. Data: 16/10/2026.

`web/filmes/` reúne orquestrador, serviços, título/duração/prévia, conexão de biblioteca, favoritos/progresso, Realtime/TanStack e políticas de resolução/buffer/áudio/legenda/reprodução. O backend específico fica em `lib/filmes/`; o núcleo VOD usado também por Séries fica em `lib/vod/`. Sessão, vídeo, HLS, áudio, seek, proxy e fila permanecem únicos. O checkpoint do filme ocorre antes de reset; somente o controlador de reprodução mede/autoriza o progresso. Sem navegador, testes automáticos ou reprodução nesta etapa.

Fontes: [mapa de Filmes](../movies-modularization-20261016.md), [player](../movies-player-modularization-20261016.md), [backend](../movies-backend-modularization-20261016.md).

## MEM-MOVIES-006 — Recomendações exclusivamente pela RPC

Estado: migration instalada e estrutura conferida; ranking da sessão real não executado. Data: 16/10/2026.

A RPC anterior estava ausente no projeto autorizado. Instalada a migration `20261016042729_arkhen_movie_identity_recommendations.sql`; leitura posterior confirmou função invoker, permissões autenticadas e índice GIN válido. O catálogo observado não oferece TMDB/coleção, portanto a versão1 de identidade usa aliases editoriais conservadores de título/ano. Ranking2 prioriza franquia→universo→gênero específico→categoria→histórico, sem ranking local ou preenchimento global por nota. Avatar/Cameron e Aang são incompatíveis. Resposta até10; apresentação5colunas desktop/responsiva. A classificação agregada não certifica o ranking com JWT nem reprodução.

Fontes: [publicação e limites](../movies-modularization-20261016.md), [contrato RPC](../movies-recommendations-ranking-20261016.md), migration citada.

## MEM-MOVIES-004 — Limitação da origem e Range

Estado: observado em logs e corrigido no código local; sem reprodução de validação.
Data: 15/10/2026. Logs sanitizados demonstraram filme502 com upstream429.
O proxy conserva429/Retry-After, aplica pausa por conta/origem e conserva416.
Leitores Range compartilham a tentativa; erro nativo terminal desanexa src,
conservando a posição antes da remoção. Não atribuir todo502 de TV à mesma causa.
Fontes: [lote de recuperação](../recovery-batch-20261015.md),
`lib/media-request-backoff.mjs`, `lib/live-playback-session.mjs`, `web/app.js`.

## MEM-MOVIES-001 — Detalhes, duração e reprodução

Estado: contrato. Data: 15/10/2026.

Filmes usam catálogo/detalhes e VOD HTTP do provedor, sem preparar transporte OTT ou EPG de TV. Duração ausente pode ser sondada apenas para o filme selecionado por leitura MP4 de intervalos limitada e cancelável; abrir a prévia não baixa o filme completo nem inicia mídia. Estado e biblioteca conservam identificadores nativos.

Fontes: `lib/wplay/vod/catalogo-nativo.mjs`, `lib/mp4-duration.mjs`, `web/movie-preview.js`, [mapa do player](../player-modules.md), [seek VOD](../vod-seek.md).

## MEM-MOVIES-002 — Recomendações privadas e Home

Estado: contrato; instalação remota deve ser confirmada separadamente. Data: 15/10/2026.

Home privada e sugestões por filme são consultas limitadas por usuário no Supabase, não varredura/ranking de toda a biblioteca no navegador. Prévia em andamento e término real oferecem sugestões sem autoplay; resposta tardia de outro filme/conta não pode substituir a seleção atual. Falha remota precisa de estado explícito, mantendo catálogo e navegação utilizáveis.

O relatório de 15/10 descreve migration de sugestões preparada sem instalação remota comprovada naquela etapa. Isso é evidência histórica, não diagnóstico atual. A revisão de Home/sugestões desta rodada ainda está em andamento.

Fontes: [contrato das recomendações](../home-and-movie-recommendations.md), [RPC de sugestões](../movie-recommendations-rpc.md), `web/home-cloud-model.js`, `web/movie-recommendations-model.js`.
