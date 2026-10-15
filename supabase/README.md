# ARKHEN — banco e sincronização

Projeto autorizado nesta implantação: **`wnicimkmzswksaqdtgdv` / ArkhenP2IPTV**. O esquema foi aplicado e verificado no serviço remoto em **15/10/2026**: 12 tabelas públicas e 3 privadas com RLS, publicação Realtime nas 12 públicas e três jobs Cron ativos. `tests/rls-verification.sql` passou no banco remoto e todas as fixtures foram revertidas.

Use `npm run supabase:project -- status` para conferir a conexão antes de operar. Esse comando usa a Management API oficial com a credencial temporária em `.local/supabase-access-token`, modo `600`, ignorada pelo Git. Os MCPs encontrados nesta sessão, inclusive no Antigravity, apontavam para outros projetos e não foram usados para nenhuma escrita. A CLI instalada apresentou incompatibilidade de vínculo/IPv6; os comandos de administração deste projeto usam HTTPS, sem alterar outros MCPs.

`npm run supabase:project -- query --file caminho.sql` executa um arquivo explicitamente escolhido. `migrate --file caminho.sql` aplica e registra uma nova migração. O token expira em sete dias; isso limita o acesso de administração do agente, não a operação do aplicativo com as chaves de servidor. Consulte [a integração do backend](../docs/supabase-backend.md) e [a biblioteca do cliente](../docs/cloud-library-client.md).

`schema-proposal.sql` é a versão revisável e idempotente. A migração em `migrations/` foi criada pelo Supabase CLI e recebe o mesmo SQL. O script recusa tabelas públicas já existentes sem identificação `ARKHEN` no comentário, evitando reinterpretar um esquema de outro aplicativo. Não use um reset de banco para resolver conflitos: confira o inventário e ajuste a migração.

## Identidade e acesso

`profiles.id` referencia `auth.users.id`. O backend primeiro valida o acesso WPLAY, resolve a identidade estável e chama as RPCs de serviço:

1. `arkhen_identity_lookup(p_library_hash)` → `[{user_id}]`.
2. `arkhen_identity_bind(p_library_hash,p_user_id,p_provider,p_provider_key,p_scope_hash)` cria o mapeamento privado e o perfil inicialmente pendente.
3. `arkhen_validate_account(p_user_id,p_status,p_expires_at,p_validated_at,p_provider_key,p_scope_hash)` registra o resultado da validação. Uma resposta antiga não sobrescreve validação mais recente.
4. `arkhen_enqueue_source_jobs(p_provider_key,p_scope_hash)` enfileira somente os trabalhos vencidos daquela fonte; logins repetidos não criam novos jobs enquanto os existentes/cadências estiverem vigentes.

O provedor e o hash da biblioteca são imutáveis. Usuários só editam `display_name`; status, validade, vínculo com provedor e validação são campos exclusivos do serviço. Nenhuma política usa `user_metadata`. Perfis podem ler apenas sua própria linha, inclusive para mostrar expiração. Os demais dados exigem perfil ativo, validade não expirada e validação feita nas últimas 24 horas.

`arkhen_private.provider_identities` guarda somente hash opaco, UUID do Auth e partição do provedor. Não guarda usuário/senha WPLAY, cookie, token, headers nem URL de reprodução. O segredo de serviço fica exclusivamente no backend; o navegador recebe apenas configuração pública e a sessão Auth daquele usuário.

## Dados pessoais e Realtime

| Tabela | Chave e conteúdo |
| --- | --- |
| `user_favorites` | `user_id,provider,item_key`; snapshot em `item` |
| `user_progress` | `user_id,provider,item_key,episode_id`; posição em `entry`; `episode_id=''` para histórico do título |
| `user_preferences` | `user_id,provider,key`; valor em `value` |
| `custom_collections` | `user_id,provider,id`; nome, tipo e `item_keys` |

Todas têm `updated_at` e `deleted_at`. O cliente só pode inserir/atualizar suas próprias linhas no provedor do perfil. Alterar o proprietário é rejeitado. Atualização mais antiga é ignorada; timestamps mais de cinco minutos no futuro são rejeitados. Exclusões de sincronização usam `deleted_at`: atualizações atrasadas não recriam uma linha removida. Hard DELETE não é concedido ao cliente.

As tabelas pessoais, perfis e metadados compartilhados entram em `supabase_realtime`; as tabelas privadas não entram. Assine **INSERT e UPDATE**, com filtro do próprio `user_id` nos dados pessoais. Evite `event: '*'` para esses dados: a documentação do Realtime explica que DELETE não aplica RLS ao registro antigo. Não foi ativado `REPLICA IDENTITY FULL` para expor versões antigas inteiras.

## Metadados compartilhados

`provider_key` identifica a fonte/servidor, e `scope_hash` identifica o conjunto de metadados compartilháveis. Ambos são derivados e escritos pelo backend. O pedido atual compartilha o catálogo da mesma fonte; se no futuro houver pacotes distintos que não devam compartilhar nem metadados, derive também a partição do pacote. O acesso à reprodução continua sendo autorizado pelo WPLAY para cada conta.

- `provider_catalog_cache`: snapshot completo por `provider_key,scope_hash,media_type` (`live`, `movies`, `series`).
- `catalog_media` e `catalog_categories`: índices normalizados do mesmo snapshot, com `is_active`; `last_seen_snapshot` registra a última mudança ou reativação. A presença no snapshot completo determina a desativação dos ausentes, sem regravar itens idênticos somente para trocar seu UUID de revisão.
- `provider_epg_cache`: programação sanitizada por canal; `epg_programs` contém os programas e horários normalizados.
- `provider_games_cache`: agenda normalizada por data e fuso.
- `episode_skip_markers`: referência global não reprodutível por série/temporada/episódio/edição, duração, marcadores e fontes públicas. `community-reference` não significa edição do provedor comprovada. O adaptador do player continua aplicando as regras de duração/edição documentadas em `web/series-markers/README.md`.

O navegador lê somente a partição registrada em seu perfil e nunca escreve nos caches ou marcadores globais. Os snapshots rejeitam URLs HTTP(S), campos de senha/token/segredo e cabeçalhos. Imagens compartilháveis precisam de uma chave/asset local, sem referências autenticadas temporárias. A proveniência dos marcadores é a exceção intencional: ela contém links públicos das bases pesquisadas, sem autenticação.

## Fila, agendamento e publicação

`arkhen_private.cache_sources` possui intervalos configuráveis pelo serviço: catálogo **86.400 s**, EPG **300 s**, jogos **60 s**. Um único cron por minuto chama `arkhen_private.enqueue_due_cache_jobs()` e apenas enfileira o que venceu. A fonte precisa estar habilitada e ter perfil ativo/recentemente validado. Não há chamada ao WPLAY por usuário ou senha gravada no cron.

O worker externo usa sua conexão WPLAY já autenticada na memória:

- `arkhen_claim_cache_jobs(p_worker,p_limit=1,p_lease_seconds=300)` retorna `id,provider_key,scope_hash,job_type,payload,attempts`.
- `arkhen_renew_cache_job(p_job_id,p_worker,p_lease_seconds=300)` mantém o lease durante operações longas.
- `arkhen_finish_cache_job(p_job_id,p_worker,p_success,p_error_code)` conclui ou tenta novamente com espera progressiva. Use somente códigos públicos e curtos, nunca a mensagem bruta do provedor.

Publicação exige o lease atual, conferido e bloqueado na mesma transação do snapshot:

```text
arkhen_publish_catalog(provider_key,scope_hash,media_type,payload,complete,snapshot_id,expires_at,job_id,worker)
arkhen_publish_epg(provider_key,scope_hash,channel_id,payload,expires_at,job_id,worker)
arkhen_publish_epg_batch(provider_key,scope_hash,channels,expires_at,job_id,worker)
arkhen_publish_games(provider_key,scope_hash,game_date,time_zone,payload,expires_at,job_id,worker)
```

Os nomes reais dos argumentos SQL têm prefixo `p_`. EPG recebe `{list:[{title,description,start,end}]}` com horários ISO; o batch recebe `[{channel_id,payload:{list:[]}}]`. Jogos recebe a agenda normalizada com `date` e `games`. Todas as RPCs de escrita/identidade/jobs são `SECURITY INVOKER`, têm `search_path` fixo e EXECUTE somente para `service_role`. Nenhuma função pública de serviço ganha privilégios por `SECURITY DEFINER`.

O catálogo só publica quando `p_complete=true` e o payload completo é válido. Inserção/atualização, desativação de ausentes e troca do cache são atômicas. Timeout, falha, snapshot parcial e lease antigo preservam os dados anteriores. Um snapshot completo vazio só deve ser declarado quando o provedor realmente confirmou ausência de conteúdo; falha de rede não é lista vazia.

`arkhen_hot_channels` é uma opção de serviço que agrega favoritos sem expor usuários; não substitui a coleta global EPG. A publicação em batch evita uma chamada SQL HTTP por canal. O worker continua necessário: `pg_cron` não executa a engine Android nem cria acesso ao P2P.

Se `pg_cron` não estiver disponível, a migração emite um aviso e a implantação precisa habilitá-lo e conferir os dois agendamentos `arkhen-cache-enqueue` e `arkhen-cache-history-prune`. O segundo remove apenas histórico de jobs concluídos/falhos com mais de 14 dias, sem apagar favoritos, catálogo ou programação por falha.

A migração adicional de retenção cria `arkhen-shared-metadata-prune`, terceiro job diário. Remove programação histórica após sete dias e agendas de jogos antigas e expiradas após trinta dias, preservando catálogos e bibliotecas pessoais. Veja [a política de retenção](../docs/supabase-retention.md).

## Verificação

`tools/test-cloud-schema.mjs` aplica o SQL duas vezes em PGlite/PostgreSQL isolado e executa verificações reais de permissões, RLS, conta/provedor, marcadores, tombstones, fila, lease e publicação atômica. Não acessa rede ou banco remoto. Instale o pacote de teste em uma pasta temporária e passe o caminho do módulo:

```sh
node tools/test-cloud-schema.mjs /private/tmp/arkhen-sql-audit/node_modules/@electric-sql/pglite/dist/index.js
```

`tests/rls-verification.sql` é a checagem SQL para executar **no projeto correto** depois de aplicar a migração. Inclui casos permitidos e negados e termina em `ROLLBACK`, sem usuários Auth fictícios permanentes. Se algum assert interromper a execução em um cliente SQL persistente, execute `ROLLBACK` antes de continuar. Confira também os advisors, a presença de `pg_cron`, seus jobs e a lista de tabelas da publicação Realtime. A entrega de eventos e a autenticação hospedada exigem validação no serviço real; o teste isolado não as simula.

Fontes verificadas: [RLS e grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [funções e privilégios](https://supabase.com/docs/guides/database/functions), [Cron](https://supabase.com/docs/guides/cron/quickstart), [Realtime e limites de DELETE](https://supabase.com/docs/guides/realtime/postgres-changes). O changelog atual informa a mudança de exposição automática da Data API: os GRANTs são explícitos nesta migração.
