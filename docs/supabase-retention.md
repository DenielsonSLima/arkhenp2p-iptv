# Retenção de programação e jogos

A migration `20261015090801_arkhen_shared_metadata_retention.sql` acrescenta a função privada `arkhen_private.prune_shared_metadata()` e o job `arkhen-shared-metadata-prune`, diário às **03:37 UTC**. A implantação passa a ter três jobs ARKHEN: enfileiramento, limpeza do histórico de jobs e retenção de metadados compartilhados.

| Dados | Remoção |
| --- | --- |
| `epg_programs` | Programas cujo término ocorreu há mais de sete dias |
| `provider_epg_cache` | Snapshot atualizado há mais de sete dias e já expirado |
| `provider_games_cache` | Datas anteriores à data UTC atual menos 30 dias, somente se o snapshot já expirou |

Programação atual/futura e snapshots não expirados permanecem. A função não altera catálogo, identidade, favoritos, listas, preferências, progresso nem marcações de episódios. Índices apoiam a busca de linhas antigas. O retorno contém apenas contagens `epg_programs`, `epg_caches` e `games_caches` removidas, sem conteúdo pessoal.

A função é `SECURITY INVOKER`, com `search_path` vazio, em schema privado e EXECUTE somente para `service_role`. O Cron executa com a identidade administrativa do agendamento. Não existe RPC pública de limpeza. Se `pg_cron` não estiver habilitado, a migration emite aviso; a implantação deve ativá-lo e conferir o job antes de considerar a retenção ativa.

Verificação isolada, sem rede:

```sh
node tools/test-cloud-retention.mjs /private/tmp/arkhen-sql-audit/node_modules/@electric-sql/pglite/dist/index.js
```

O teste aplica a migration duas vezes, remove dados vencidos antigos, preserva dados recentes/não expirados e bibliotecas/catálogos antigos, verifica repetição sem novas exclusões e bloqueio para `anon`/`authenticated`. `supabase/tests/retention-inventory.sql` confere no serviço remoto a função, seus privilégios e o agendamento sem remover dados.
