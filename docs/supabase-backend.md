# Biblioteca na nuvem e atualização compartilhada

`lib/supabase-cloud.mjs` é o adaptador REST do servidor. `lib/shared-cache-worker.mjs` executa a fila compartilhada. Não usam dependências npm nem emitem JWTs próprios: a sessão é criada pelo Supabase Auth.

## Configuração e projeto

O adaptador lê `.local/supabase.json`, ignorado pelo Git, com `{url,publishableKey,secretKey}`. `serviceRoleKey` é aceito como alternativa à chave de servidor. O arquivo deve ter acesso somente pelo usuário do processo; a chave secreta nunca deve ir para `web/`, variáveis públicas ou logs.

A origem permitida por padrão é exclusivamente `https://wnicimkmzswksaqdtgdv.supabase.co`. Outra origem, query, credenciais na URL ou caminho adicional falham antes de enviar uma chave. O construtor recebe configuração explícita em testes. A ausência do arquivo ou `enabled:false` desativa a integração; configuração existente inválida é um erro, não uma troca silenciosa de projeto.

```js
const cloud = new SupabaseCloud();
await cloud.ready;
if (cloud.enabled) cloud.publicConfig(); // somente URL e publishableKey
```

As chaves novas `sb_publishable_…` e `sb_secret_…` são enviadas em `apikey`, sem fingir que são JWTs. Chaves JWT legadas também usam Authorization. Todas as solicitações usam HTTPS, origem fixa, timeout e bloqueio de redirecionamento; erros públicos não carregam o corpo cru do serviço.

Login e consultas comuns têm prazo de 15 segundos. Publicação de catálogo/EPG tem prazo HTTP de 65 segundos, enquanto as três funções específicas do banco têm `statement_timeout=55s`, dentro do teto REST documentado. O restante das funções e dos papéis conserva seu limite. `CLOUD_TIMEOUT` identifica o prazo de transporte; SQLSTATE `57014` vira `CLOUD_DATABASE_TIMEOUT`, sem expor SQL ou texto cru. A migration `20261015095103_arkhen_shared_metadata_set_based.sql` publica conjuntos completos e só atualiza títulos/programas quando os dados mudam, reduzindo trabalho e eventos Realtime. [Timeouts oficiais](https://supabase.com/docs/guides/database/postgres/timeouts).

## Login após validação WPLAY

`bootstrap({session,client,provider})` exige uma sessão WPLAY aceita pelo cliente do servidor, status ativo, validade não vencida e validação do provedor feita há no máximo 24 horas. Um objeto recebido do navegador não deve ser usado como `session` ou `client`. O app servidor é responsável por chamar esse método somente depois de autenticar o provedor.

1. `account.libraryId` é o hash estável e privado usado na busca `arkhen_identity_lookup`.
2. Quando necessário, o servidor cria um usuário Auth com endereço sintético `<libraryHash>@accounts.arkhen.invalid`, senha aleatória independente e email confirmado. A senha WPLAY nunca é lida ou enviada para o banco.
3. `admin/generate_link` gera um magic link sem enviar email. O servidor confere ID, email e o hash em `app_metadata`, que o usuário não pode editar.
4. `arkhen_identity_bind` associa o usuário Auth no mapeamento privado; `arkhen_validate_account` atualiza status, validade, fonte e data da validação em campos administrados pelo servidor. A RLS exige conta ativa, validade e validação recente.
5. `arkhen_enqueue_source_jobs` cria somente os jobs globais iniciais/vencidos; logins repetidos não abrem uma atualização por usuário.
6. `/auth/v1/verify`, usando a chave pública e o hash gerado, devolve uma sessão real. Somente seus tokens e o ID público do usuário voltam ao navegador. O hash de uso único, action link, OTP e chave secreta não são enviados ao cliente.

O retorno é `{url,publishableKey,session:{access_token,refresh_token,token_type,expires_in?,expires_at?,user:{id}},userId,providerKey,scopeHash}`. Cada login cria sua própria sessão de refresh, inclusive quando dois aparelhos entram ao mesmo tempo. Pedidos da mesma identidade são executados em fila: cada magic link é verificado antes de gerar o seguinte, reaproveitando o usuário Auth sem compartilhar tokens entre aparelhos. Uma falha não bloqueia os pedidos seguintes. `revoke(accessToken)` encerra somente a sessão local, preservando outros aparelhos.

`lib/cloud-runtime.mjs` integra esse contrato ao ciclo do `lib/app-server.mjs`: `/api/login` e `/api/session` retornam `cloud` no nível superior, acrescentando `provider` e `libraryId`, mais `cloudStatus`. `server.mjs` carrega a configuração somente quando executado diretamente; `createApp()` e importações em testes permanecem desativados, salvo injeção explícita. A CSP libera HTTPS/WSS somente para o projeto autorizado. Uma falha de nuvem preserva a conexão válida com o provedor e informa o estado indisponível.

Antes de reutilizar uma sessão da nuvem, o runtime confere status, validade, identidade e data de autenticação do provedor. As rotas compartilhadas chamam `client.connect()`, aproveitando a memoização normal de cinco minutos do WPLAY. Nova validação ou mudança de vencimento atualiza o perfil sem criar outro magic link. Rejeição explícita ou vencimento remove a fonte, revoga a sessão local e atualiza status no banco, bloqueando RLS mesmo para JWT ainda válido. Prova local com mais de 24 horas exige nova validação sem desativar globalmente outros aparelhos. O cliente OTT ainda conserva sua política anterior de sessão em memória; após esse prazo exige nova entrada.

## Escopo global de metadados

Por solicitação explícita do projeto, metadados WPLAY são compartilhados por origem do provedor. `cloudSourceScope()` calcula `providerKey` de tipo de provedor + origem canônica, e `scopeHash = sha256('arkhen-shared-v1:' + providerKey)`. Nome, senha, query e tokens não entram nessas chaves públicas. A identidade privada de cada usuário continua separada.

Essa escolha compartilha o catálogo de metadados entre todos os usuários dessa origem. A reprodução continua autorizada pelo cliente WPLAY individual; um registro no catálogo compartilhado não concede um stream. Caso o provedor disponibilize pacotes com catálogos diferentes e seja necessário também isolar sua descoberta, será preciso usar um identificador de pacote/tenant comprovado fornecido por ele. Os métodos já aceitam `providerKey`/`scopeHash` explícitos pelo servidor para essa evolução.

## Worker local, fila e leases

```js
const worker = new SharedCacheWorker({cloud});
worker.registerSource({session, client, provider, providerKey, scopeHash});
worker.start();
// worker.stop() cancela timers; nunca encerra o player do cliente.
```

O cron do Postgres **enfileira** trabalho; ele não possui a sessão Android nem credenciais WPLAY para fazer a coleta. O Node precisa continuar executando e ter um cliente autenticado registrado na memória. Não há senha WPLAY persistida no Supabase nem tarefa autônoma de coleta enquanto esse processo estiver desligado.

O polling padrão é de dez segundos, um job por vez no processo. A RPC `arkhen_claim_cache_jobs` concede um lease de 300 segundos; `arkhen_renew_cache_job` o renova a cada 60 segundos. Publicações incluem ID do job e worker, e as RPCs validam sua posse transacionalmente. Perda de lease, troca de geração ou fonte indisponível impedem novas publicações. `arkhen_finish_cache_job` registra sucesso ou um código de falha seguro. Parar o worker ou retirar uma fonte nunca chama `stopPlayback()` ou fecha a engine de reprodução.

O seletor opcional `chooseSource(job,candidates)` permite escolher uma das referências autenticadas registradas para a origem/escopo. Deve retornar o objeto de fonte com `client`, `session`, `providerKey` e `scopeHash`. A referência deve manter conta ativa, validade e autenticação recente. O estado opcional `onStatus` contém somente estado, tipo do job, código de erro e horário.

## Publicação e integridade

- **Catálogo:** vence em 24 horas. Percorre todas as páginas de cada categoria até `hasMore:false`, com verificação de avanço da página e limite de proteção. Cada tipo (`live`, `movies`, `series`) é publicado apenas completo por `arkhen_publish_catalog`. Falha ou paginação incompleta não marca títulos antigos como removidos. Não usa fontes de vídeo nem sonda duração reproduzindo conteúdo.
- **EPG:** vence em cinco minutos. O job global percorre os IDs ao vivo com no máximo duas chamadas de cliente em paralelo e publica uma única `arkhen_publish_epg_batch`. O cliente WPLAY já compartilha um download global e índice em RAM; percorrer IDs não cria um download upstream por canal/usuário. Se uma consulta falhar, o lote antigo permanece. Um job futuro pode trazer `payload.channel_ids` para limitar a canais específicos.
- **Jogos:** vence em um minuto. Consulta uma agenda por escopo/data/fuso e publica `arkhen_publish_games`. Datas do campo WPLAY confirmado como UTC seguem [o contrato da agenda](games.md). Erro de negócio do serviço não vira agenda vazia.

Os sanitizadores publicam somente campos explicitamente permitidos. Removem listas de fontes, endereços de reprodução, tokens, senhas e `/api/image?ref=…` ligados a um login. Assets locais e referências globais de imagem são aceitos. O callback opcional `mapImage(value,{client,providerKey,scopeHash})` deve registrar a origem somente na memória do servidor e retornar `/api/shared-image/<sha256>` ou `/api/shared-image?ref=<sha256>`; URLs externas cruas não passam para os snapshots públicos. Sem esse registrador, imagens temporárias ficam vazias, preservando a segurança do cache.

Os endpoints Node usam o cache compartilhado como fonte principal de catálogo, EPG e jogos. Um catálogo completo vencido continua visível enquanto solicita atualização; EPG/jogos vencidos consultam a fonte autenticada. A ausência temporária de cache usa uma consulta em RAM coalescida por origem/escopo/tipo, preservando o compartilhamento entre usuários. Atualização manual usa `arkhen_request_cache_refresh`, com trava/cooldown global no banco. Detalhes e reprodução continuam utilizando o cliente individual para validar permissões.

As imagens usam `/api/shared-image/<sha256>` e um registro de origem/headers somente em RAM. O hash remove parâmetros reconhecidos de autenticação, sem publicar a origem ou tokens no banco. Após reiniciar o Node, o primeiro cliente autenticado aquece esse registro percorrendo os metadados uma vez por origem/escopo no processo, mesmo se o snapshot do banco ainda estiver válido. Esse aquecimento não invalida catálogos nem publica dados; reaproveita as páginas memoizadas pelo cliente. Pedidos de capa aguardam a referência específica ficar disponível, sem esperar todos os catálogos, até vinte segundos. Outros usuários da mesma origem reutilizam o aquecimento. Nenhuma fonte de vídeo é consultada para reconstruir capas.

## Verificação

`node --test tests/supabase-cloud.test.mjs tests/shared-cache-worker.test.mjs tests/cloud-runtime.test.mjs tests/app-server-cloud.test.mjs tests/wplay-games.test.mjs` cobre autorização prévia, criação e reaproveitamento de identidade, separação das chaves, sessão Auth simulada, escopo global, sanitização, paginação completa, concorrência de dois EPGs, idempotência, interrupção e perda de lease, HTTP/CSP, corrida de logout, bloqueio de conta inativa e reconstrução de capas após reinício. Os fixtures não usam credenciais reais. A aprovação desses testes não comprova um login WPLAY e bootstrap Auth reais no projeto remoto; essa verificação depende de uma conta válida do provedor, além de SQL aplicado e configuração local.

Referências oficiais verificadas para os endpoints e headers: [Auth createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp), [tipos de API key](https://supabase.com/docs/guides/getting-started/api-keys) e [contrato HTTP do Supabase Auth](https://github.com/supabase/auth/blob/master/openapi.yaml).
