# Cliente da biblioteca na nuvem

Supabase mantém os dados centrais publicados e a biblioteca privada de cada conta. O TanStack Query mantém as consultas privadas em memória; o catálogo completo usa também IndexedDB no Chrome/TV por 24 horas. A biblioteca local e a outbox preservam alterações durante uma falha de conexão. Entrar em outro navegador restaura os registros daquela conta pelo Supabase, sem depender do armazenamento do primeiro navegador.

O POST de autenticação WPLAY e a coleta HTTP de catálogo/EPG/jogos podem ocorrer nas Edge Functions do modo gateway. O backend confiável mantém a sessão individual; engine P2P, endpoints de vídeo em loopback e logos locais de canais continuam locais. `CloudLibrary` não transmite vídeo, não recebe a senha do provedor e não recebe o segredo HMAC do gateway.

## Arquivos e responsabilidades

| Arquivo | Responsabilidade |
| --- | --- |
| `web/cloud-runtime-entry.js` | Entrada do bundle local com Supabase JS e TanStack Query Core reais. Não usa CDN em tempo de execução. |
| `web/cloud-library.js` | Sessão, consultas, mutações, Realtime, importação e integração com os mapas locais. |
| `web/cloud-app-bridge.js` | Integra a conta ativa, preferências e coleções da interface; evita gravar novamente alterações recebidas da nuvem. |
| `web/cloud-library-records.js` | Contratos dos registros, validação e remoção de endereços de reprodução/imagens vinculadas à sessão. |
| `web/cloud-outbox.js` | Fila local por projeto, provedor e usuário, com alterações pendentes e tombstones. Não armazena credenciais. |
| `web/catalog-cache.js` | Snapshots globais completos em IndexedDB, com TTL de 24 horas e partições independentes de projeto/provedor/escopo/tipo/adulto. |
| `web/library-catalog.js` | Resolve favoritos da conta mesmo quando o título ainda não está entre os metadados carregados. |
| `web/parental-control.js` | Modal acessível e estado efêmero do controle parental; valida o PIN pela API do servidor. |
| `tests/cloud-library.test.mjs` | QueryClient verdadeiro com transporte Supabase injetado, sem chamadas à assinatura do provedor. |
| `tests/cloud-app-bridge.test.mjs` | Fluxo de interface, importação da conta correta, revisões de preferências e remoções de coleções. |

## Inicialização

O backend deve validar o login WPLAY antes de devolver `cloud` com `url`, `publishableKey`, `userId`, `provider`, `providerKey`, `scopeHash`, `libraryId` e `session: {access_token, refresh_token}`. Nunca devolver uma chave secreta ou `service_role`.

`connect(cloud)` valida o usuário com `auth.getUser()`, confere seu perfil ativo e a partição autorizada e só então carrega favoritos, progresso, preferências e coleções. O SDK mantém sua própria sessão por projeto e usuário. Uma sessão persistida do mesmo usuário tem preferência sobre o bootstrap antigo: o refresh token pode ter sido rotacionado desde a resposta do backend. Reconectar a conta já ativa não faz logout.

Falha transitória na conexão inicial limpa consultas e encerra as tarefas do SDK com `auth.dispose()`, preservando a sessão Auth armazenada. Assim a próxima tentativa pode reutilizar seu refresh token, mesmo quando o backend ainda conserva o bootstrap anterior. Logout explícito, usuário divergente ou perfil sem acesso continuam encerrando a sessão com `signOut({scope:'local'})`.

Uma rejeição real de Auth (`401`/`403` na etapa de autenticação, ou refresh inválido) permite ao bridge pedir `/api/session?cloud=refresh`. O servidor exige a conta do provedor ainda válida, agrega solicitações concorrentes e limita a emissão por sessão. O SDK usa esse bootstrap novo em vez da credencial antiga persistida. Falha de rede, política de perfil ou callback da interface não solicita essa recuperação. Diagnósticos registram somente código, etapa e status; callbacks de renderização não revogam a sessão Auth.

As chaves TanStack incluem projeto, provedor, usuário, tabela e partição. As quatro consultas privadas permanecem registradas até logout para que invalidações Realtime continuem funcionando. Dados compartilhados têm expiração própria; um catálogo incompleto não é utilizado.

## Integração da interface

O fluxo já está conectado em `web/app.js`. A sincronização começa em segundo plano depois da biblioteca local e das configurações da conta terem sido ativadas; a disponibilidade da nuvem não bloqueia a abertura do catálogo. O estado aparece no rodapé e em Configurações → Perfil → Sua biblioteca. “Biblioteca sincronizada” só aparece depois da confirmação das gravações; envio ou falha têm estados próprios.

O bridge atualiza `/api/session` e tenta recuperar o bootstrap automaticamente (espera de cinco segundos até um minuto), também ao focar a página ou voltar à rede. Realtime refaz as consultas ao entrar/reentrar no canal, recuperando alterações ocorridas durante a desconexão. Gravações pendentes são reenviadas com espera crescente, sem depender de um novo login. Migrações de dados locais carregadas em páginas posteriores do catálogo também notificam a sincronização.

1. Ative primeiro a biblioteca local com o `libraryId` da conta validada.
2. Chame `connect(cloud)` e assine `subscribe(snapshot)`; o snapshot contém favoritos, histórico recente, episódios, preferências e coleções.
3. `hydrate({favoritesMap, historyMap, episodeProgress})` mescla por data e aplica exclusões remotas de favoritos. `syncLocal({libraryId, favoritesMap, historyMap, episodeEntries})` importa os registros locais dessa conta, preservando exclusões remotas mais recentes. Dados legados sem identidade comprovada precisam do fluxo explícito de importação da biblioteca local.
4. Use `saveFavorite(item, active)`, `savePreference(key, value)` e `saveCollection(...)` nas respectivas alterações. Coleções aceitam `collection_type` igual a `live`, `movies` ou `series`; a remoção usa `removeCollection()` com o registro completo.
5. Use `saveProgress(entry)` durante a reprodução. Alterações do mesmo episódio são agrupadas por cinco segundos; `{force:true}` força o envio ao sair ou trocar de título. `pagehide` inicia um POST com `keepalive` para o progresso pendente.
6. `logout()` cancela consultas, remove canais Realtime, limpa caches e encerra a sessão Supabase local. A fila de alterações não enviadas permanece isolada para a próxima autenticação da mesma conta.

O servidor aplica a regra de última alteração por `updated_at`. A fila local evita ressuscitar um favorito removido durante uma falha de rede. Ao voltar à conexão, `flushOutbox()` reaplica apenas registros sanitizados da conta atual. O estado informa que há mudanças pendentes; falha de rede não é apresentada como sincronização concluída. A fila é limitada a 2.000 registros, e cada tabela privada é carregada em páginas de até 1.000, com limite de 10.000 registros.

Realtime assina apenas `INSERT` e `UPDATE`: exclusões de dados privados usam `deleted_at`. Não há assinatura de `DELETE` ou `*`. Mudança do perfil para inativo, expirado ou outra partição encerra a sincronização e pede nova validação.

Preferências de catálogo, áudio, volume de cada canal, ordenação e reprodução de séries são restauradas por conta. Coleções pessoais também são sincronizadas. Receber um snapshot não dispara outra mutação. Ao alternar contas, o bridge invalida operações anteriores e restaura os valores daquela conta; a limpeza do SDK anterior termina antes da criação do próximo cliente de autenticação.

## Dados compartilhados

`cachedCatalog(type)`, `epg(channelId)` e `games(date,timeZone)` leem somente a partição do perfil e devolvem `null` quando o cache está ausente ou expirado. Os escritores desses caches pertencem ao backend/worker. O frontend nunca grava catálogos, endereços de reprodução ou tokens de outros usuários nesses dados.

O aplicativo continua consultando `/api/catalog`, `/api/epg` e `/api/games`: o Node seleciona os dados centrais e agenda atualização pela Edge quando o cliente usa coleta cloud. O fallback legado pode consultar o provedor. A origem HTTP temporária fica cifrada em tabela privada por até duas horas; essa fonte não contém a senha WPLAY e não faz parte dos dados que o navegador consulta. O caminho diário de catálogo usa a resposta completa, com `snapshotId`, `revisionAt` e validade provenientes do header confirmado no Supabase. A RPC `arkhen_catalog_page` continua disponível para prévias e leituras limitadas, com cursor e revisão; o filtro adulto ocorre antes do limite. Os métodos diretos do cliente são adaptadores de leitura.

Na abertura, filmes/séries ou o catálogo da tela escolhida têm prioridade. A recuperação de favoritos e títulos com progresso fora da página carregada ocorre em segundo plano. A interface aquece até 30 capas, com prazo total de 2,5 segundos; o restante carrega conforme necessário. Categorias são ordenadas alfabeticamente em pt-BR, preservando as entradas utilitárias e os IDs internos.

O catálogo publicado é baixado completo uma vez por tipo e por dia, usando a resposta completa de `/api/catalog?type=…`, e gravado em IndexedDB. Ler o cache não renova sua validade. A navegação e a busca usam esse conjunto local contínuo; não exigem uma página de rede para cada movimento na TV. Reloads dentro das 24 horas reutilizam o snapshot sem outra consulta de catálogo. Após o vencimento, a atualização ocorre em segundo plano; uma falha de rede preserva o catálogo antigo para consulta. Vídeo ainda exige a fonte e autorização individuais. Se IndexedDB estiver indisponível ou sem espaço, o snapshot completo em RAM conserva o orçamento diário durante aquela execução.

Somente catálogos completos podem substituir um snapshot persistido: uma prévia `preparing:true` não é um catálogo completo, mesmo que use `source=supabase` e `hasMore:false`. Durante a primeira preparação global, o servidor pode fornecer até 120 títulos por tipo para a interface abrir; isso não inicia outra varredura WPLAY em cada navegador. A busca informa que novos títulos ainda estão chegando. Eventos globais não descartam um cache diário válido; atualização manual pode antecipar uma nova leitura.

O cache de catálogo não contém favoritos, progresso, preferências, senhas, fontes de vídeo ou URLs do provedor. O modo adulto tem chave própria e é removido ao bloquear novamente. O cache padrão é sanitizado contra categorias e marcadores adultos antes de ser gravado. Itens privados de Minha lista permanecem no escopo da conta: a ausência em uma prévia ou primeira página não elimina o favorito. Snapshots dessa conta mantêm suas categorias e flags adultas e continuam sujeitos aos filtros da interface; o servidor autoriza a reprodução de cada ID.

As referências de imagem são globais e opacas. O backend consulta `catalog_artwork_refs`, aplica o controle parental e pede a imagem à Edge. A capa é baixada somente quando necessária e armazenada sob seu hash no Supabase Storage; o navegador recebe um redirect para o objeto público opaco. Uma origem cifrada com parâmetros de autenticação dura até duas horas, limitada pela fonte validada; sem eles pode durar um dia. Objetos já criados são reutilizados por 24 horas e podem continuar como stale sem fonte válida. Capas inéditas podem exigir nova autenticação/coleta. O fallback local resolve apenas os detalhes do título necessário, sem varrer todos os catálogos no login; logos locais de canais preservam seu caminho funcional.

Escudos das agendas cloud também são servidos pelo cache local de logos. Sua origem cifrada fica no Supabase e os bytes podem passar pelo espelho lazy do Storage, após comprovar que a referência pertence aos campos de logo de uma agenda da partição autorizada.

`markerManifest(seriesSlug)` reconstrói o contrato do catálogo de aberturas/créditos a partir de `episode_skip_markers`. Sem dados acessíveis, retorna `null` para permitir o fallback ao JSON local. A classificação de referência comunitária e a verificação de duração continuam no módulo de marcações.

O leitor de marcações é invalidado na primeira sincronização da conta e pelo resumo Realtime `marker_cache_versions`, filtrado em `name=global`. Esse evento invalida as consultas dos marcadores sem transmitir cada linha da carga compartilhada. O episódio aberto consulta novamente sem aguardar outra reprodução. Marcas manuais têm precedência. Referências comunitárias continuam identificadas como teste e dependem da correspondência da duração.

## Controle parental

Configurações → Controle parental abre um diálogo nativo com foco no campo de PIN, mensagens acessíveis e entrada mascarada. O conteúdo adulto começa bloqueado; o PIN inicial `0000` é verificado somente pelo servidor. Após cinco erros, o servidor exige uma espera de 60 segundos. O PIN não é salvo em localStorage, na outbox ou nas preferências sincronizadas.

O desbloqueio vale somente para aquela sessão do navegador. Sair, trocar de conta ou reiniciar o backend bloqueia novamente. Bloquear pela interface interrompe o player e limpa páginas, detalhes e buscas em memória; os registros privados de favoritos/progresso permanecem preservados, e só aparecem quando o título está autorizado. `Adult Swim` permanece disponível.

O bloqueio também é verificado no servidor para detalhes, links de reprodução, episódios, segmentos, EPG e imagens. Não depende apenas de esconder cartões na interface. Essa versão usa o PIN inicial fixo e não implementa alteração persistente de PIN ou perfis familiares.

## Verificação e limites

Execute `node --test tests/cloud-library.test.mjs tests/cloud-app-bridge.test.mjs tests/channel-volume-memory.test.mjs`. Esses testes exercitam Query Core real, cancelamento, isolamento de conta, rollback, exclusões offline, refresh rotacionado e contratos do cliente. O transporte injetado não comprova RLS, publicação Realtime, credenciais de implantação ou persistência remota; esses itens exigem testes separados no projeto Supabase real.

Referências: [sessão Supabase](https://supabase.com/docs/reference/javascript/auth-setsession), [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes), [QueryClient](https://tanstack.com/query/latest/docs/framework/react/reference/QueryClient).
