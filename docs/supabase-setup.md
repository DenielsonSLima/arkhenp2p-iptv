# Supabase do ARKHEN

Projeto: `wnicimkmzswksaqdtgdv` (ArkhenP2IPTV). Configuração inicial aplicada em 15/10/2026.

Nesta instalação, o backend usa a Edge Function `arkhen-backend` para as operações privilegiadas. A chave administrativa fica no ambiente do Supabase; `.local/supabase.json` guarda URL, chave pública e somente a credencial HMAC restrita da função. Login da CLI e `supabase link` dão acesso de administração ao agente, mas não ativam sozinhos a configuração do aplicativo. O navegador usa a sessão própria da conta para lista, progresso e Realtime.

## O que está no banco

- `profiles` e mapeamento privado de identidade: o backend valida a conta no WPLAY antes de criar ou reaproveitar o usuário Supabase Auth. A senha WPLAY não vai ao banco.
- `user_favorites`, `user_progress`, `user_preferences`, `custom_collections`: favoritos/lista, posição por filme ou episódio, preferências e coleções pessoais com isolamento por usuário e sincronização Realtime.
- `catalog_media`, `catalog_categories`, `provider_catalog_cache`: filmes, séries e canais separados por `media_type`, com atualização completa e desativação de ausentes somente após consulta bem-sucedida.
- `epg_programs`, `provider_epg_cache`, `provider_games_cache`: programação e jogos compartilhados pela origem do provedor.
- `episode_skip_markers`: tempos de abertura/créditos por série, temporada, episódio e edição, com duração e origem da referência.

O seed possui 83 referências de Game of Thrones e Os Anéis de Poder. Apenas referências comunitárias compatíveis com a duração podem participar do teste automático. Registros divergentes não pulam trechos; não representam validação da edição WPLAY. Os tempos manuais do usuário têm prioridade.

A ampliação SkipDB acrescentou 1.049 edições de 14 séries, totalizando 1.132 registros remotos. São 1.024 edições SkipDB ativas, incluindo políticas que apenas preservam o conteúdo final; isso não significa 1.024 aberturas conferidas no WPLAY. A coleta global diária e os critérios de duração/conflito estão em [importação SkipDB](skipdb-markers.md).

## Atualização global

O Cron enfileira os trabalhos vencidos: catálogo a cada 24 horas, programação a cada 5 minutos, jogos a cada minuto. Um worker Node consome essa fila, publica o resultado no Supabase e o compartilha entre os usuários daquela origem. Leases e espera progressiva evitam execuções duplicadas.

**O worker precisa do backend ligado e de uma fonte WPLAY autenticada.** O banco agenda os trabalhos, mas não executa a engine Android nem consulta o WPLAY sozinho. Enquanto o Node estiver desligado, o Supabase conserva o último conteúdo coletado. Essa dependência precisa ser hospedada quando sair do ambiente local.

## Arquivos e operação

| Arquivo | Função |
| --- | --- |
| `.local/supabase.json` | URL, publishable key e credencial HMAC do gateway; sem chave administrativa nesta instalação; ignorado pelo Git |
| `supabase/functions/arkhen-backend/` | Operações administrativas restritas e assinadas; chave de serviço somente no ambiente Supabase |
| `.local/bin/supabase.exe` | CLI autenticada e vinculada ao projeto nesta máquina Windows |
| `tools/supabase-project.mjs` | Alternativa antiga de administração HTTPS, exige PAT próprio em `.local/supabase-access-token` |
| `supabase/migrations/` | Alterações versionadas do banco |
| `lib/supabase-cloud.mjs`, `lib/cloud-runtime.mjs` | Identidade, sessão e integração das APIs locais |
| `lib/shared-cache-worker.mjs` | Coleta global e publicação de snapshots |
| `web/cloud-library.js`, `web/cloud-app-bridge.js` | TanStack Query, Realtime, integração com a interface e fila offline |
| `web/series-markers/` | Leitura dos tempos do banco, fallback local e referências pesquisadas |

Recompile o cliente após atualizar suas dependências com `npm run build:cloud`. O aplicativo exige Node 22 ou posterior. Inicie com `npm run start:p2p` e faça login WPLAY; o perfil Supabase é provisionado sem uma segunda tela de cadastro.

Inventário nesta máquina: `.\.local\bin\supabase.exe db query --linked --file supabase/tests/inventory.sql`. A checagem `supabase/tests/rls-verification.sql` testa acesso permitido e negado numa transação com rollback, sem deixar contas fictícias permanentes.

## Evidência desta configuração

O projeto respondeu `ACTIVE_HEALTHY`; inventário confirmou 15 tabelas com RLS, Realtime nas 12 públicas e três jobs Cron ativos, incluindo retenção de programação/jogos históricos. A checagem remota de isolamento passou com rollback e zero fixtures restantes. O inventário após importar SkipDB confirmou 1.132 referências; 55 registros antigos divergentes continuam sem automação. A função administrativa de ativação de RLS não pode ser executada por `anon` ou `authenticated`.

A entrada WPLAY válida provisionou o perfil real. A consulta remota confirmou 1 perfil, 760 canais, 50.209 registros de programação e uma agenda de jogos compartilhada. Filmes e séries ainda estavam em coleta nessa checagem. Não foi criado perfil fictício nem reaproveitada uma sessão APK como autenticação web.

O teste explícito `node tools/verify-cloud-live.mjs` confirmou conexão, gravação e entrega Realtime entre dois clientes com sessões independentes, além de preservar a segunda sessão após logout da primeira. O registro temporário foi removido ao final. O comando opera somente um perfil já validado e fica fora da suíte automática.

A correção desta instalação também restaurou 37 favoritos e 6 históricos em dois contextos isolados do Chrome. Favorito, remoção e posição de episódio chegaram por Realtime; a posição persistiu depois de recarregar. A consulta final confirmou zero registros temporários. No modo gateway, a ferramenta de verificação usa a CLI autenticada exclusivamente para remover sua preferência aleatória de teste, pois a Edge Function não oferece exclusão administrativa dos dados privados.

Referências do serviço: [Management API](https://supabase.com/docs/reference/api/introduction), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime](https://supabase.com/docs/guides/realtime/postgres-changes).
