# Privacidade de reprodução adulta

Conteúdo adulto usa o bloqueio parental e PIN inicial `0000`. O desbloqueio permite assistir; não autoriza persistir histórico, posição, episódio recente ou “Continuar assistindo”. Favoritos expressamente salvos continuam pertencendo ao usuário e não são apagados pela política de histórico.

## Proteção no Supabase

A migração `20261015171124_arkhen_adult_progress_privacy.sql` mantém as políticas de dono/provedor e acrescenta proteção em `user_progress`:

- `BEFORE INSERT OR UPDATE` recusa uma gravação adulta com SQLSTATE `P0001` e mensagem fixa `ARKHEN_ADULT_PROGRESS_DISABLED`, sem incluir usuário, título ou payload no erro. O cliente deve descartar essa operação da fila de sincronização, sem tentativas repetidas.
- A classificação confiável usa o perfil mantido pelo servidor, provedor, escopo, tipo, ID e geração publicada. Considera a coluna adulta, metadados positivos e categorias atuais. A chave completa inclui a geração; `isAdult:false` no cliente não desclassifica um item conhecido.
- Marcadores positivos no registro, item ou episódio também impedem a gravação. São considerados flags `adult/isAdult/is_adult` e marcadores explícitos de nome/grupo. Uma classificação etária isolada de 18 anos não basta; `Adult Swim` permanece uma exceção de marca.
- Uma política `SELECT` restritiva oculta imediatamente progresso reclassificado como adulto. Todas as funções de leitura e classificação são `SECURITY INVOKER`; nenhuma permissão de dono ou partição foi ampliada.
- A home exclui adulto do histórico, dos sinais e das recomendações mesmo com `p_include_adult=true`. Os favoritos explícitos respeitam o desbloqueio. Um filtro final confere metadados positivos somente nos até 150 resultados selecionados, preservando a leitura compacta do catálogo.

IDs antigos ou desconhecidos sem indicação adulta são preservados. O sistema depende da classificação recebida do provedor: um título sem marcador e ainda ausente do catálogo não pode ser classificado com segurança apenas por um ID opaco.

## Limpeza e reclassificação

`arkhen_prune_adult_progress` pode ser executada somente pelo serviço e remove no máximo 500 registros por chamada, com lock de transação e `SKIP LOCKED`. O job interno executa a manutenção a cada cinco minutos. Ela cobre progresso adulto confirmado no catálogo atual ou positivamente marcado no próprio registro, incluindo tombstones antigos. Não altera favoritos, coleções ou o catálogo e não grava um histórico individual da limpeza.

Se um item antes não classificado passar a ser adulto numa publicação futura, seu progresso fica invisível pelo RLS antes da próxima manutenção física. Esse intervalo de até um ciclo não significa autorização para exibir o registro.

## Verificação

O fixture PostgreSQL/PGlite em `tools/test-home-library.mjs` passou 63 asserções, incluindo escrita comum e administrativa, categorias com coluna do item ainda falsa, episódio adulto com série não marcada, registros antigos, isolamento entre contas/partições, PIN desbloqueado, limites e preservação de favoritos.

A migração foi aplicada e registrada no projeto autorizado. A prova no PostgreSQL remoto usou o papel `authenticated`, a conta válida e uma transação revertida: três gravações foram recusadas, uma por tipo, mesmo com flag negativa no payload. A execução da limpeza foi negada ao usuário. A política restritiva, o agendamento e as opções locais de plano da home permaneceram ativos.

Na conferência de 15/10/2026 havia 13 registros de progresso e 92 favoritos. Nenhum progresso foi identificado como adulto; a limpeza inicial removeu zero registros, os 92 favoritos permaneceram e a contagem adulta posterior foi zero. Nenhum teste de escrita foi mantido.

A primeira leitura real da home encontrou timeout de oito segundos: o lookup de uma chave herdava a opção que desencoraja nested loops no ranking amplo. A migração aditiva `20261015172532` configura o plano somente nesse lookup e impõe uma materialização antes da classificação dos metadados selecionados. O SELECT privado mediu 45–79 ms e a home candidata, 4.865 ms em transação revertida; nenhuma política ou limite foi relaxado.

Após aplicar essa correção, a API real com JWT levou 5.086 ms na primeira home bloqueada e 1.537 ms na consulta desbloqueada. Ambas retornaram zero itens adultos em histórico/recomendações e 30 recomendações. A leitura privada retornou 13 progressos visíveis e 90 favoritos ativos (os 92 registros físicos incluem remoções antigas). A sessão de teste foi revogada ao terminar; o teste não gravou dados pessoais. Esses números são uma fotografia da conta em uso, não limites fixos do aplicativo.

Referências: [triggers no Supabase](https://supabase.com/docs/guides/database/postgres/triggers) e [RLS no Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).
