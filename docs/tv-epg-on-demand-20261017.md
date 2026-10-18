# TV/EPG por canais necessários e validade da janela

Data: 17/10/2026 UTC. Esta etapa sucede a [limpeza de EPG](epg-architecture-cleanup-20261016.md). Preserva cálculo no servidor, publicação compartilhada prioritária, fallback autorizado, agenda da mesma revisão e fonte WPLAY com cadência de seis horas.

## Causa encontrada

Mesmo com `ids` na rota HTTP, `arkhen_tv_guide` calculava o mapa inteiro antes de filtrar. O conector enviava `p_channel_ids:null`. O cron de minuto mudava `epg_cache_versions.projection_version/as_of` e regravava a projeção JSON completa para ambas as visibilidades, inclusive sem espectadores. As migrations anteriores já reaproveitavam janelas até suas fronteiras; o progresso continuava causando escrita e invalidação global por minuto.

O navegador tinha uma consulta compartilhada, mas não informava os canais necessários. Quatro favoritos, um canal reproduzido e seus vizinhos ainda demandavam o mapa global e sua expansão. Isso comprova trabalho evitável no código, sem atribuir toda a CPU a essa fase.

## Banco

Migration efetiva: [20261017011816_arkhen_tv_guide_on_demand_channels.sql](../supabase/migrations/20261017011816_arkhen_tv_guide_on_demand_channels.sql). A CLI criou inicialmente a versão `20261017011349`; o responsável principal alinhou o nome ao histórico remoto, sem reaplicar a alteração.

`arkhen_tv_guide` mantém assinatura, DTO e `ids=null` como leitura completa de compatibilidade. Para subconjuntos, filtra provedor, escopo, geração live, atividade, visibilidade adulta e IDs **antes** do lookup do payload EPG por chave primária. O filtro de elegibilidade é repetido ao montar a resposta.

A tabela privada `arkhen_private.epg_channel_windows` mantém anterior/atual/próximo por provedor, escopo, canal e fuso. Refaz a janela somente quando falta entrada, muda a revisão EPG, vence qualquer início/fim real de programa ou o relógio recua. Os seletores conservam ordenação, empates, sobreposições, lacunas e listas vazias. Fronteira nula significa ausência de nova mudança conhecida naquela revisão, sem prolongar programas.

Progresso, tempo decorrido e restante são calculados em SQL para as linhas solicitadas, com um único `stamp`, sem escrever esses valores no cache ou no registry público. `asOf` indica o cálculo; `projectionVersion` identifica a projeção. `nextRefreshAt` conserva o minuto, a fronteira real mais próxima e a expiração futura do snapshot. Seleção de programa e regras de progresso não foram transferidas ao navegador.

RPC e publicador usam o mesmo advisory lock por partição, conservando cabeçalho e payloads da mesma publicação entre as instruções. Uma mudança concorrente do catálogo ainda pode deixar uma chamada já iniciada usar a geração capturada no começo, como anteriormente; a seguinte usa a nova. Conta, PIN e epoch continuam revalidados no backend após esperas.

O helper privado `refresh_tv_guide` virou wrapper de compatibilidade para a RPC completa. `arkhen_tick_tv_guides` não reconstrói projeções e o cron `arkhen-tv-guide-clock` fica inativo por `cron.alter_job`, com nome, agenda e dois comandos conhecidos conferidos. **Publicador atômico EPG e jobs de captura não foram alterados**: a origem ainda publica `epg_cache_versions.revision` e sua revisão compacta real. Parar o relógio global não para publicação de EPG.

O cache tem RLS e acesso somente `service_role`, sem credenciais, fontes privadas ou seleção pessoal. A PK evita duplicação por espectador/visibilidade. A FK remove linhas quando a partição do registry sai. IDs antigos podem permanecer privados enquanto a partição existe; não passam no filtro atual de geração/atividade. Retenção passiva adicional é follow-up dependente de medição, não foi criada outra migration ou rotina nesta etapa.

## Backend e cliente

`TvGuideRuntime` normaliza IDs e os inclui na chave de cache/deduplicação. Subconjuntos não preenchem a entrada reservada ao mapa completo. Uma projeção completa válida já existente pode atendê-los; o runtime não cria essa projeção para uma leitura pequena. Limite de entradas e cooldown de erro permanecem.

`ConectorTvSupabase` encaminha IDs à RPC. A recuperação WPLAY continua condicionada à ausência/degradação central ou ao orçamento de espera existente. Publicação fresca/completa pode legitimamente não informar programas para os canais pedidos: isso não dispara download integral WPLAY. A expansão lê IDs autorizados do retorno e confere a mesma revisão antes/depois. Falhas não promovem captura parcial/antiga sobre publicação completa.

`TVGuideClient.subscribe(listener,{ids})` registra uma lista ou função de seleção; `unsubscribe.updateIds()` informa mudanças. Cards, favoritos, player, prévia e vizinhos formam uma união na mesma consulta. Montagens síncronas são coalescidas por microtask. Mudança durante leitura deixa revalidação pendente, sem abrir pedido por card. `TVServices` preserva os IDs no transporte e na chave de deduplicação.

Assinaturas sem IDs mantêm o contrato completo. União acima de 2.000 IDs ou 6.000 caracteres usa o mapa completo em vez de cortar canais ou exceder limites de URL. Aba oculta, ausência de consumidores, retorno da visibilidade, retry e revisão continuam no ciclo existente. A UI não calcula o programa ou progresso.

Integrações: cards, feed, vizinhos, faixa do player, grade de favoritos e prévia de troca. O principal ajustou `web/app.js` para passar o item da prévia ao subscriber. Guia não reinicia vídeo, altera canal, muda rankings da Home ou carrega Filmes/Séries.

## Verificação e operação

Após a aplicação registrada em **17/10 às 01:18:16 UTC**, o principal confirmou os seguintes corpos por readback. A operação não forneceu um `observed_at` confiável; não se atribui horário separado à leitura:

| Objeto | `md5(prosrc)` confirmado |
|---|---|
| RPC `arkhen_tv_guide` | `d4bb56ed00c68ed5f0ab6ccd718987c7` |
| Wrapper privado | `bd0b16947f17fa530b795cbc9ca1862f` |
| Tick sem reconstrução | `14939ecb98c466af2fb01426295f6482` |
| Publicador EPG preservado | `6a68961fb58abb31d8ad4b5659d63e68` |

O readback confirmou `clockActive=false`, RLS e grants somente de servidor para a tabela. A tentativa inicial com `UPDATE cron.job` foi recusada por permissão; sua transação não foi tomada como aplicada. A versão aplicada usa `cron.alter_job`. Sucesso e hashes comprovam definições/permissões, **não certificam queda de CPU, latência final, interface ou reprodução**.

Validação local: inspeção estática, peer independente de SQL/cliente e `node --check` dos onze arquivos JS/MJS modificados. Sem testes automatizados, navegador, mídia, chamada de guia por RPC ou benchmark. O agente TV não operou Supabase remoto. Publicação/ativação do código Node e navegador deve ser distinguida da aplicação SQL.

Operações preparadas:

- [Readback de metadados](../supabase/operations/readback-tv-guide-on-demand-20261017.sql), sem aquecer cache ou ler contas/programas.
- [Hashes esperados](../supabase/operations/tv-guide-on-demand-expected-20261017.json).
- [Rollback explícito](../supabase/operations/rollback-tv-guide-on-demand-20261017.sql): recusa funções divergentes, restaura três corpos anteriores, remove só o cache novo e reativa o cron conhecido preservando comando/agenda. Reintroduz o custo global por minuto; não deve ser usado como otimização. Origem, biblioteca, progresso e favoritos são preservados.
