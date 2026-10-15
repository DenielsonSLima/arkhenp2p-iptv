# Cliente da biblioteca na nuvem

O player continua usando o provedor WPLAY. `CloudLibrary` sincroniza dados da biblioteca com Supabase; não transmite vídeo nem recebe a senha do provedor.

## Arquivos e responsabilidades

| Arquivo | Responsabilidade |
| --- | --- |
| `web/cloud-runtime-entry.js` | Entrada do bundle local com Supabase JS e TanStack Query Core reais. Não usa CDN em tempo de execução. |
| `web/cloud-library.js` | Sessão, consultas, mutações, Realtime, importação e integração com os mapas locais. |
| `web/cloud-app-bridge.js` | Integra a conta ativa, preferências e coleções da interface; evita gravar novamente alterações recebidas da nuvem. |
| `web/cloud-library-records.js` | Contratos dos registros, validação e remoção de endereços de reprodução/imagens vinculadas à sessão. |
| `web/cloud-outbox.js` | Fila local por projeto, provedor e usuário, com alterações pendentes e tombstones. Não armazena credenciais. |
| `tests/cloud-library.test.mjs` | QueryClient verdadeiro com transporte Supabase injetado, sem chamadas à assinatura do provedor. |
| `tests/cloud-app-bridge.test.mjs` | Fluxo de interface, importação da conta correta, revisões de preferências e remoções de coleções. |

## Inicialização

O backend deve validar o login WPLAY antes de devolver `cloud` com `url`, `publishableKey`, `userId`, `provider`, `providerKey`, `scopeHash`, `libraryId` e `session: {access_token, refresh_token}`. Nunca devolver uma chave secreta ou `service_role`.

`connect(cloud)` valida o usuário com `auth.getUser()`, confere seu perfil ativo e a partição autorizada e só então carrega favoritos, progresso, preferências e coleções. O SDK mantém sua própria sessão por projeto e usuário. Uma sessão persistida do mesmo usuário tem preferência sobre o bootstrap antigo: o refresh token pode ter sido rotacionado desde a resposta do backend. Reconectar a conta já ativa não faz logout.

Falha transitória na conexão inicial limpa consultas e encerra as tarefas do SDK com `auth.dispose()`, preservando a sessão Auth armazenada. Assim a próxima tentativa pode reutilizar seu refresh token, mesmo quando o backend ainda conserva o bootstrap anterior. Logout explícito, usuário divergente ou perfil sem acesso continuam encerrando a sessão com `signOut({scope:'local'})`.

As chaves TanStack incluem projeto, provedor, usuário, tabela e partição. As quatro consultas privadas permanecem registradas até logout para que invalidações Realtime continuem funcionando. Dados compartilhados têm expiração própria; um catálogo incompleto não é utilizado.

## Integração da interface

O fluxo já está conectado em `web/app.js`. A sincronização começa em segundo plano depois da biblioteca local e das configurações da conta terem sido ativadas; a disponibilidade da nuvem não bloqueia a abertura do catálogo. O estado da conexão aparece em Configurações → Perfil → Sua biblioteca.

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

O aplicativo continua consultando `/api/catalog`, `/api/epg` e `/api/games`: o Node seleciona o cache compartilhado ou consulta o provedor e mantém o vínculo das imagens autorizadas. Os métodos diretos do cliente são adaptadores de leitura, não substituem esse broker no fluxo atual.

`markerManifest(seriesSlug)` reconstrói o contrato do catálogo de aberturas/créditos a partir de `episode_skip_markers`. Sem dados acessíveis, retorna `null` para permitir o fallback ao JSON local. A classificação de referência comunitária e a verificação de duração continuam no módulo de marcações.

O leitor de marcações é invalidado na primeira sincronização da conta e em eventos Realtime de `episode_skip_markers`; o episódio aberto consulta novamente sem aguardar outra reprodução. Marcas manuais têm precedência. Referências comunitárias continuam identificadas como teste e dependem da correspondência da duração.

## Verificação e limites

Execute `node --test tests/cloud-library.test.mjs tests/cloud-app-bridge.test.mjs tests/channel-volume-memory.test.mjs`. Esses testes exercitam Query Core real, cancelamento, isolamento de conta, rollback, exclusões offline, refresh rotacionado e contratos do cliente. O transporte injetado não comprova RLS, publicação Realtime, credenciais de implantação ou persistência remota; esses itens exigem testes separados no projeto Supabase real.

Referências: [sessão Supabase](https://supabase.com/docs/reference/javascript/auth-setsession), [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes), [QueryClient](https://tanstack.com/query/latest/docs/framework/react/reference/QueryClient).
