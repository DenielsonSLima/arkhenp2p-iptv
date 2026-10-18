# Backend da seleção de TV na Home

Implementação inicial em 16/10/2026, atualizada localmente em 17/10 UTC para um destaque e quatro recentes. A nova migration permanece local nesta etapa; testes internos sintéticos não certificam disponibilidade remota nem reprodução.

`lib/tv/home-orquestrador.mjs` atende duas rotas depois da validação compartilhada da conta. `home-request.mjs` valida somente os filtros de TV e a referência de reprodução. `home-conector-supabase.mjs` usa o cliente Supabase e o JWT já existentes, sem inicializar SDK, Realtime, engine, coletor ou login WPLAY próprios.

| Rota | Entrada | Origem do resultado |
| --- | --- | --- |
| `POST /api/tv/home` | `hidden: string[]`, `hiddenItems: string[]` | `arkhen_home_tv`, um destaque e até quatro recentes ordenados no banco |
| `POST /api/tv/watch-heartbeat` | `id`, `attempt`, `playing`, os mesmos filtros | `arkhen_tv_watch_heartbeat`, relógio do banco |

A leitura obtém uma lista canônica autorizada de TV e envia seus IDs elegíveis à RPC. Não consulta fontes de cada canal nem inicia transmissões. O banco seleciona um canal pelo tempo medido nas últimas 168 horas e até quatro recentes distintos, revalidando a geração publicada, metadados, categorias adultas, disponibilidade e filtros. Favoritos e histórico de Filmes/Séries permanecem independentes. O histórico antigo pode fornecer recência; seus valores de posição ou duração não viram tempo assistido.

O DTO conserva `schemaVersion:1` e acrescenta `featuredId`; o backend aceita a resposta anterior sem esse campo durante a transição. O primeiro item tem motivo `most-watched` ou `default-globo`; os seguintes têm `recent`. Sem campeão semanal elegível, a RPC prefere TV/Rede Globo genérica; na ausência dela, escolhe o primeiro nome que começa `Globo ` pela ordem nativa do catálogo e pelo ID, excluindo Globo News/GloboNews e Globoplay. Uma afiliada é um padrão editorial com nome integral preservado, sem inferir a localização da conta. Se nenhum canal elegível existir, a RPC não inventa um substituto.

O padrão possui `mostWatchedId:null`, `watchedSeconds:0` e `lastWatchedAt:null`; sua leitura não grava histórico, lease ou tempo. Os recentes vêm somente de eventos privados reais. A deduplicação remove apenas rótulos técnicos terminais do nome completo para impedir versões HD/FHD de ocuparem duas posições ou repetirem o destaque; região, números e pontuação permanecem. A contagem semanal não junta estatísticas entre IDs.

`20261017020723_arkhen_home_tv_featured_and_four_recent.sql` altera somente a projeção: não modifica batimentos, buckets ou retenção. Antes dos classificadores e do JSON, materializa somente IDs com histórico ou nomes candidatos Globo. A programação dos cards continua no fluxo EPG existente, separado desta consulta privada.

Verificação interna desta alteração: 19 testes Node de DTO/backend/modelo e 113 asserções do harness PostgreSQL PGlite em memória, incluindo 24 novas asserções de TV. Cobrem seleção, recência, filtros, RLS/ACL, deduplicação, ausência de escrita pelo padrão e corte exato de 168 horas. Nenhum navegador, autenticação de conta real, RPC privada remota ou mídia foi usado nesses testes.

O heartbeat exige a intenção atual do servidor, canal e tentativa correspondentes, geração de autenticação e reprodução válidas e finalidade `playback`. Um sinal `true` também exige o transporte principal ativo. A finalidade `preview` nunca é promovida pelo mesmo token. UUID da medição e sequência são gerados no backend; tempo decorrido, posição e relógio do cliente não são aceitos. Cada estado serializa suas escritas e agrupa sinais `true` repetidos em menos de dez segundos. Pausa/espera/erro/parada enviam `false`.

`homeTvRoutes.finish(state, client, {intent})` captura a medição anterior antes do STOP ou de uma nova intenção. Agenda seu encerramento na mesma fila dos batimentos, com prazo de seis segundos, sem fazer a troca de mídia aguardar o banco. Pode concluir depois da aposentadoria do transporte, preservando proprietário, conta, autenticação e PIN capturados. O hook de uma nova reserva atua somente quando muda o objeto da intenção; uma consulta repetida ao manifesto não encerra a medição. Troca de autenticação ou encerramento do processo pode impedir essa última confirmação. Os tempos são aproximações por batimentos com limites explícitos, não certificação audiovisual exata.

Uma falha de transporte conserva o número e o valor exatos do batimento pendente. O próximo sinal pode reconhecer essa mesma operação idempotente antes de registrar uma mudança de estado. Uma resposta tardia não atualiza outra conta, PIN ou intenção. O SQL mantém um único lease privado por proprietário e partição; mede intervalos, limita cada crédito a vinte segundos e rejeita intervalos maiores que trinta e cinco segundos.

`currentPlaybackIntent` e `retirePlaybackAttempt`, em `lib/live-playback-session.mjs`, dão suporte ao STOP por tentativa. Um STOP antigo não para o player atual. Uma abertura cancelada antes do primeiro GET recebe um tombstone, impedindo que esse GET tardio abra a prévia. O token de uma intenção atual válida não é aposentado por um callback com finalidade divergente.

Diagnósticos `[tv-home]` e `[tv-watch]` registram somente fase, código, duração e status remotos sanitizados, com repetição limitada. Não incluem canal, conta, JWT, biblioteca ou URL de mídia.

A migration `20261016054432_arkhen_private_tv_watch_home.sql` mantém estatísticas e leases em tabelas privadas com RLS e sem acesso direto autenticado. RPCs derivam o proprietário do JWT e validam a partição. Apenas uma revisão compacta, privada por proprietário, é publicada no Realtime; isso permite invalidar somente a consulta dos quatro cards.
