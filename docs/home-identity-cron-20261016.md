# Job de identidades da Home — incidente de16/10/2026

Estado: auditoria de código e pausa pontual confirmada em readback administrativo em aproximadamente 23h04 UTC de 16/10/2026. Saúde e CPU posteriores não foram certificadas.

O log PostgreSQL apresentado na investigação identificou `select public.arkhen_prepare_home_identities(1000);` com 15.896,421 ms. As capturas também mostram cancelamentos 57014; sem correlação por sessão/PID, não se atribui cada cancelamento a essa rotina. A leitura administrativa feita pelo integrador confirmou o job 9, `arkhen-home-identities`, ativo e agendado a cada minuto. As capturas do usuário mostravam CPU em 99% e banco sem saúde. Esse conjunto localiza um trabalho recorrente do próprio projeto; não demonstra uma falha global do Supabase nem prova que um único job explica toda a CPU.

## Caminho e custo observáveis no código

- [Criação da identidade e trigger](../supabase/migrations/20261015164721_arkhen_home_library.sql#L7): normalização, extração de ano e expressões regulares. O trigger das linhas24–29 calcula a identidade nas novas inserções e mudanças de metadados; o job serve para preencher gerações anteriores.
- [Lote e agendamento](../supabase/migrations/20261015164721_arkhen_home_library.sql#L31): até1.000 atualizações na mesma transação, lock consultivo, `SKIP LOCKED`, geração publicada e repetição por minuto. Um cancelamento reverte o lote inteiro; havendo pendências, a execução seguinte pode repetir o mesmo trabalho sem avançar.
- [Índice parcial de pendências](../supabase/migrations/20261015164721_arkhen_home_library.sql#L30) e [índice da identidade atual](../supabase/migrations/20261016050044_arkhen_home_library_compact_candidates.sql#L14) dependem de `home_identity`. Atualizar essa coluna altera a participação/chave desses índices e impede HOT para essa atualização. O PostgreSQL documenta essa condição em [Heap-Only Tuples](https://www.postgresql.org/docs/current/storage-hot.html).
- [Índice de recomendações](../supabase/migrations/20261016042729_arkhen_movie_identity_recommendations.sql#L82): expressãoGIN que classifica nome/ano em famílias e universos. A manutenção de índices e as expressões regulares podem ampliar o custo das atualizações nãoHOT. O tempo específico dessa fase não foi medido; depende de plano e estatísticas após recuperação.

15,896s por chamada/minuto corresponde a26,5% do minuto ocupado em tempo de parede por esse trabalho, caso o padrão se repita. Isso não equivale a uma medida de CPU. O retorno de linhas afetadas e a contagem de pendências não estavam disponíveis no log.

Outros agendamentos coincidem no minuto:

| Job | Fonte | Trabalho potencial |
|---|---|---|
| `arkhen-cache-enqueue` | [schema:532](../supabase/migrations/20261015044236_arkhen_cloud_schema.sql#L532) | Enfileira fontes com trabalho vencido. |
| `arkhen-cloud-catalog-sync` | [coletor:157](../supabase/migrations/20261015115930_arkhen_cloud_collector.sql#L157) | Acorda o coletor. |
| `arkhen-catalog-navigation` | [modelos:206](../supabase/migrations/20261015164720_arkhen_catalog_query_models.sql#L206) | Prepara o modelo de uma geração pendente; orçamento declarado45s. Se falhar sem publicar, a geração continua pendente. |
| `arkhen-tv-guide-clock` | [TV:203](../supabase/migrations/20261016022551_arkhen_tv_guide_snapshots.sql#L203) | Atualiza até8 partições e duas visibilidades por partição; orçamento declarado20s. |
| `arkhen-catalog-generation-cleanup` | [gerações:185](../supabase/migrations/20261015152804_arkhen_catalog_generations.sql#L185) | Busca gerações aposentadas e remove até500 registros por chamada. |

A coincidência dos agendamentos é uma fonte possível de contenção; cada fase precisa de sua própria duração antes de alterar outro job.

## Contenção revisável

O integrador recebeu `/tmp/arkhen-home-cron-pause.sql`. A transação exige nome, comando e cadência observados e altera somente `active=false` por `cron.alter_job`; preserva definição e histórico. Não remove job, tabela, índice, snapshot, biblioteca ou RLS. Não cancela uma execução já em andamento.

O caminho com `FOR UPDATE` foi recusado por permissão e retirado sem alterar grants. Após timeouts, o integrador usou a [instrução direta guardada](../supabase/operations/pause-home-identities.sql). Uma leitura posterior separada confirmou `active=false`, com nome e cadência originais. A investigação de tamanho/CPU segue independente dessa confirmação.

O arquivo separado `/tmp/arkhen-home-cron-resume-original.sql` restaura somente o estado ativo original, com as mesmas guardas. Não deve ser executado durante o incidente. O uso de `cron.alter_job(...,active:=false)` segue a [API oficial do pg_cron](https://github.com/citusdata/pg_cron#altering-a-cron-job).

## Otimização ainda não aplicada

O rascunho `/tmp/arkhen-home-identities-bounded-draft.sql` conserva geração publicada, classificação, lock consultivo, `SKIP LOCKED`, invocador e permissões existentes. Propõe lote máximo50, ordem compatível com o índice parcial e atualização pelo `ctid` capturado e bloqueado dentro da mesma instrução. Não cria índices, não reescreve catálogo inteiro e não reativa agendamento.

Depois da saúde restaurada: conferir a definição remota, contar pendências de maneira indexada, verificar o plano sem executar e medir um lote pequeno. Se pendências forem zero, o trigger já cobre novos dados e a tarefa de backfill pode permanecer inativa. Somente se ainda houver trabalho validado considerar lotes menores/cadência espaçada, com prazo configurado antes da chamada e retorno de linhas afetadas. Nenhum aumento de timeout global foi proposto.


## Tamanho das tabelas e retenção — inspeção local

O esclarecimento posterior do usuário identificou `catalog_media` com 120 MB, `catalog_artwork_refs` com 35 MB e `catalog_categories` com 136 kB. Apenas uma dessas tabelas ultrapassa 100 MB. Após a pausa, uma leitura respondeu: mídia 119,97 MiB no total, 60,10 MiB de tabela/TOAST e 59,87 MiB de índices; referências 35,31 MiB no total, 13,98 MiB de tabela/TOAST e 21,33 MiB de índices. As primeiras consultas haviam expirado. Contadores de tuplas vieram zerados e datas de manutenção nulas: não permitem concluir que estão vazias ou sem bloat. Tamanho isolado não explica a CPU. A decomposição e os bytes medidos estão no [relatório do incidente](supabase-incident-20261016.md).

- **Cópias esperadas:** [provider_catalog_cache:103–112](../supabase/migrations/20261015044236_arkhen_cloud_schema.sql#L103) mantém um JSON completo por provedor/escopo/domínio; [catalog_media:130–145](../supabase/migrations/20261015044236_arkhen_cloud_schema.sql#L130) mantém metadados por item. A [publicação por geração:127–146](../supabase/migrations/20261015152804_arkhen_catalog_generations.sql#L127) conserva ambas as representações e troca a geração visível. Colunas geradas armazenadas e índices também ocupam espaço ([campos de consulta:85–96](../supabase/migrations/20261015164720_arkhen_catalog_query_models.sql#L85)). `catalog_snapshots` é somente o nome de uma métrica em [health.sql:5](../supabase/tests/health.sql#L5), não uma tabela criada pelas migrations locais revisadas.
- **Cópias temporárias:** páginas coletadas, [itens normalizados:6–19](../supabase/migrations/20261015141803_arkhen_catalog_publish_batches.sql#L6) e [snapshot preparado:6–13](../supabase/migrations/20261015151331_arkhen_catalog_snapshot_preparation.sql#L6) podem coexistir até a publicação. O caminho de sucesso [remove essas cópias:150–154](../supabase/migrations/20261015152804_arkhen_catalog_generations.sql#L150). São tabelas privadas vinculadas ao job com `ON DELETE CASCADE`.
- **Gerações aposentadas:** existe [limpeza a cada minuto:185–207](../supabase/migrations/20261015152804_arkhen_catalog_generations.sql#L185), com até 500 linhas **no total**, na ordem referências de arte → mídia → categorias, apenas após um dia. Protege geração visível, snapshot atual, preparação e trabalho em andamento. Crescimento é possível se a limpeza falhar/ficar inativa, se a entrada superar o escoamento ou se preparações abandonadas continuarem protegendo gerações. A existência da migration não comprova execução atual desse cron.
- **Preparações e modelos antigos:** o cron diário [remove jobs concluídos/falhos com mais de 14 dias:533](../supabase/migrations/20261015044236_arkhen_cloud_schema.sql#L533), permitindo as cascatas; jobs que permanecem `queued`/`leased` não entram nessa retenção. Modelos de navegação têm duas visibilidades e repetem listas de IDs por ordenação/categoria/gênero; a limpeza das gerações antigas ocorre somente [no final do builder:78–81](../supabase/migrations/20261016051752_arkhen_movie_recommendations_snapshot_memberships.sql#L78). Falha contínua dessa preparação pode conservar modelos antigos.
- **Capas e retenção geral:** [catalog_artwork_refs:48–54](../supabase/migrations/20261015113615_arkhen_catalog_pages.sql#L48) contém referências/hash e campo, não os bytes das capas, que pertencem ao bucket [arkhen-catalog-artwork:78–80](../supabase/migrations/20261015115927_arkhen_cloud_provider_sources.sql#L78). Não foi encontrada nessas migrations uma coleta de objetos Storage órfãos. A [retenção compartilhada:11–32](../supabase/migrations/20261015090801_arkhen_shared_metadata_retention.sql#L11) limpa EPG antigo e jogos vencidos; não é uma limpeza de catálogo ou biblioteca pessoal.

Nenhuma exclusão, `VACUUM`, `REINDEX` ou alteração de retenção foi executada por esta revisão. O próximo diagnóstico deve separar volume válido de catálogo, gerações/preparações retidas e tuplas mortas; somente os resultados podem justificar uma intervenção proporcional.
