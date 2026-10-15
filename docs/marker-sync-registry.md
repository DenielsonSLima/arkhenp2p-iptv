# Registro global de sincronização de aberturas

Configurações possui um módulo independente e somente leitura para acompanhar SkipDB e IntroDB. Abrir ou atualizar o painel consulta o Supabase; não consulta diretamente os provedores, inicia importações nem altera favoritos, progresso ou o catálogo.

## Fontes e prioridade

O worker `series-markers-sync` consulta SkipDB primeiro. Falha, ausência de referência, resposta inválida ou cooldown levam à consulta IntroDB para o episódio. Quando SkipDB fornece uma abertura utilizável como referência, IntroDB não substitui nem mistura seus tempos. Referências comunitárias, com ou sem duração, são somente diagnósticas até existir verificação da mídia IPTV. Identificar a série ou contar uma referência não garante botão de pulo, marcação executável ou cobertura de todos os episódios.

O player exige `verified`, vínculo exato de edição/fonte e validação de série, temporada, episódio e duração. Não calcula interseções entre provedores nem oferece o antigo botão de referência bruta. A reprodução padrão usa créditos verificados/manuais e, na ausência deles, aguarda `ended`; offsets já salvos permanecem respeitados. A política e os testes estão em [Verificação de marcações](marker-playback-verification.md).

`configured` representa apenas a presença de uma chave no ambiente seguro da função. `false` significa acesso público; `null` indica que o worker anterior ainda não informou esse dado. A última consulta válida, erro tipado e limite de consultas descrevem observações reais, sem afirmar disponibilidade contínua do serviço. A chave nunca entra no contrato público.

## Dados exibidos

- Base global: episódios monitorados, séries, referências de abertura/recapitulação/créditos, edições e referências ainda sem comprovação da edição. Episódios monitorados incluem pendentes e resultados vazios; não significam episódios sincronizados com sucesso.
- Catálogo atual: séries publicadas e não adultas da partição autorizada, identificadas, pendentes, sem correspondência ou com falha; episódios conhecidos e com referências das séries identificadas.
- Identificações recentes: até 20 títulos, IMDb público e contagens de cobertura reais. A identificação não atribui uma única fonte a toda a série.
- Pendências: até 20 títulos do mesmo catálogo com motivo tipado. Nenhum título adulto, geração ainda não publicada ou outra partição aparece nesses detalhes.
- Últimos ciclos: até 20 registros globais persistidos, com horário, estado, duração e contadores sanitizados. O banco retém 30 dias, removendo no máximo 100 registros antigos por ciclo.

O histórico detalhado começou nesta implantação. A migração preservou o último ciclo real disponível; não reconstruiu um passado inexistente. Uma execução interrompida aparece como parcial quando a lease expira e é registrada como `MARKER_RUN_INTERRUPTED` quando o worker retoma.

A cobertura tem um resumo global por IMDb atualizado pelo agendador a cada cinco minutos. `global.updatedAt` e `catalog.updatedAt` informam quando esse resumo foi calculado; `generatedAt` informa somente a consulta ao painel. Os ciclos e o estado dos provedores continuam registrados imediatamente. Antes do primeiro resumo, a cobertura retorna `null`, não zero. Se uma atualização falhar, o último resumo e sua data permanecem válidos.

## Contrato e isolamento

A rota local `GET /api/markers/sync-status` usa a sessão Supabase do usuário e chama `arkhen_marker_sync_status(p_provider_key, p_scope_hash)`. A RPC é `SECURITY INVOKER`, exige autorização da partição e mantém as políticas RLS das tabelas. As projeções `marker_sync_registry` e `marker_sync_runs` permitem apenas leitura a contas com autorização ativa; navegador não recebe permissão para iniciar tarefas, ler leases nem gravar o histórico.

A agregação global deduplica IMDb/temporada/episódio entre edições e provedores. A cobertura do catálogo deriva das identidades resolvidas da geração visível. Biblioteca e progresso individuais não participam dessa consulta.

O trigger de projeção seleciona somente campos conhecidos do resultado interno: contadores numéricos limitados, horários, status e códigos. Identificadores de execução internos, caminhos de Storage, URLs, payloads brutos e credenciais não são copiados. A nova interface não altera as assinaturas Realtime dos catálogos.

## Implantação e verificações

Em 15/10/2026, a migração `20261015155746_arkhen_marker_sync_registry.sql` foi aplicada e registrada no projeto `wnicimkmzswksaqdtgdv`. A função `series-markers-sync` foi publicada preservando sua autenticação existente por segredo exclusivo do agendador. A leitura do registro continua autenticada com JWT e RLS.

O teste autenticado real revelou que agregar os 97.370 registros de evidências por abertura/recapitulação/créditos levava 9.488 ms e excedia o orçamento da chamada REST. A migração `20261015162134_arkhen_marker_sync_metrics.sql`, aplicada e registrada no mesmo projeto, move esse cálculo para um único resumo global em segundo plano. O primeiro resumo foi construído antes da validação. O leitor permanece autenticado e `SECURITY INVOKER`; nenhuma permissão ou limite global foi ampliado. A gravação do resumo e de sua data é atômica.

Após essa alteração, a chamada REST com JWT de usuário levou 894 ms. O resumo das 16:30 UTC continha 57.524 episódios monitorados em 1.590 séries globais; o catálogo autorizado tinha 8.118 séries visíveis, 59 identificadas e 1.057 episódios com referências. São contagens observadas naquele instante e continuam mudando conforme o worker avança. A sessão temporária usada nesse teste foi revogada ao final.

Uma consulta operacional somente leitura confirmou um ciclo com `MARKER_DATABASE_UNAVAILABLE` às 16:28 UTC: a chamada de banco atingiu 10.001 ms sem itens processados. O registro dessa versão não informa a operação exata que falhou, portanto não se atribui uma causa específica ao banco ou aos provedores. Os oito ciclos seguintes, entre 16:30 e 16:35 UTC, terminaram com estado `ready`, zero falhas e dez episódios consultados por ciclo. IntroDB retornou referências em quatro desses ciclos. Nenhuma tarefa foi reiniciada para obter esse resultado.

Validações internas: 37 asserções SQL em PostgreSQL local/PGlite para partições, RLS, geração, adulto, histórico limitado, idempotência, interrupção, sanitização e preservação do resumo em falha; 30 testes JavaScript de pipeline, retenção, telemetria e fallback. Os casos de fallback cobrem erro de rede, 404, vazio, cooldown, identidade divergente e preservação dos tempos da fonte primária. A validação visual final pertence ao usuário.

Referências oficiais: [SkipDB API](https://skipdb.tv/docs), [IntroDB](https://introdb.app), [Supabase Database Functions](https://supabase.com/docs/guides/database/functions).
