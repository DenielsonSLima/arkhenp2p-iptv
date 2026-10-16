# Backend da seleção de TV na Home

Implementação local em 16/10/2026. A conferência desta etapa é estática e de sintaxe; publicação SQL e reprodução real são verificações separadas.

`lib/tv/home-orquestrador.mjs` atende duas rotas depois da validação compartilhada da conta. `home-request.mjs` valida somente os filtros de TV e a referência de reprodução. `home-conector-supabase.mjs` usa o cliente Supabase e o JWT já existentes, sem inicializar SDK, Realtime, engine, coletor ou login WPLAY próprios.

| Rota | Entrada | Origem do resultado |
| --- | --- | --- |
| `POST /api/tv/home` | `hidden: string[]`, `hiddenItems: string[]` | `arkhen_home_tv`, até quatro canais ordenados no banco |
| `POST /api/tv/watch-heartbeat` | `id`, `attempt`, `playing`, os mesmos filtros | `arkhen_tv_watch_heartbeat`, relógio do banco |

A leitura obtém uma lista canônica autorizada de TV e envia seus IDs elegíveis à RPC. Não consulta fontes de cada canal nem inicia transmissões. O banco seleciona um canal pelo tempo acumulado e até três recentes distintos, revalidando a geração publicada, metadados, categorias adultas, disponibilidade e filtros. Favoritos e histórico de Filmes/Séries permanecem independentes. O histórico antigo pode fornecer recência; seus valores de posição ou duração não viram tempo assistido.

O heartbeat exige a intenção atual do servidor, canal e tentativa correspondentes, geração de autenticação e reprodução válidas e finalidade `playback`. Um sinal `true` também exige o transporte principal ativo. A finalidade `preview` nunca é promovida pelo mesmo token. UUID da medição e sequência são gerados no backend; tempo decorrido, posição e relógio do cliente não são aceitos. Cada estado serializa suas escritas e agrupa sinais `true` repetidos em menos de dez segundos. Pausa/espera/erro/parada enviam `false`.

`homeTvRoutes.finish(state, client, {intent})` captura a medição anterior antes do STOP ou de uma nova intenção. Agenda seu encerramento na mesma fila dos batimentos, com prazo de seis segundos, sem fazer a troca de mídia aguardar o banco. Pode concluir depois da aposentadoria do transporte, preservando proprietário, conta, autenticação e PIN capturados. O hook de uma nova reserva atua somente quando muda o objeto da intenção; uma consulta repetida ao manifesto não encerra a medição. Troca de autenticação ou encerramento do processo pode impedir essa última confirmação. Os tempos são aproximações por batimentos com limites explícitos, não certificação audiovisual exata.

Uma falha de transporte conserva o número e o valor exatos do batimento pendente. O próximo sinal pode reconhecer essa mesma operação idempotente antes de registrar uma mudança de estado. Uma resposta tardia não atualiza outra conta, PIN ou intenção. O SQL mantém um único lease privado por proprietário e partição; mede intervalos, limita cada crédito a vinte segundos e rejeita intervalos maiores que trinta e cinco segundos.

`currentPlaybackIntent` e `retirePlaybackAttempt`, em `lib/live-playback-session.mjs`, dão suporte ao STOP por tentativa. Um STOP antigo não para o player atual. Uma abertura cancelada antes do primeiro GET recebe um tombstone, impedindo que esse GET tardio abra a prévia. O token de uma intenção atual válida não é aposentado por um callback com finalidade divergente.

Diagnósticos `[tv-home]` e `[tv-watch]` registram somente fase, código, duração e status remotos sanitizados, com repetição limitada. Não incluem canal, conta, JWT, biblioteca ou URL de mídia.

A migration `20261016054432_arkhen_private_tv_watch_home.sql` mantém estatísticas e leases em tabelas privadas com RLS e sem acesso direto autenticado. RPCs derivam o proprietário do JWT e validam a partição. Apenas uma revisão compacta, privada por proprietário, é publicada no Realtime; isso permite invalidar somente a consulta dos quatro cards.
