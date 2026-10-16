# Guia global de TV

Atualização posterior: o [registro de recuperação EPG](tv-epg-recovery-20261016.md) documenta a recuperação integral WPLAY compartilhada e os ajustes de escopo/entrega. O caminho de programação já não depende exclusivamente da disponibilidade do bootstrap Supabase.

A API local também tem `lib/tv-guide-compat.mjs`: durante falha da RPC/Edge, lê
os caches Supabase existentes em lote e calcula o DTO no backend. O retorno
declara `source:legacy-cache`, `partial:true`, `stale:true`; canal sem linha
fica indisponível sem apagar os demais. Não consulta WPLAY, não dispara coleta
e não comprova uma nova revisão. Dados brutos são compartilhados por até6h,
com limite de oito partições; a projeção vence no minuto/boundary.

Implementação local preparada em 15/10/2026. A migration foi aplicada no projeto
autorizado e registrada como `20261016022551_arkhen_tv_guide_snapshots.sql`.
A chamada administrativa atingiu o deadlineHTTP de 30s; o readback somente
leitura confirmou schema e histórico às 02:26:42 UTC de 16/10, sem reenviar DDL.
O arquivo criado inicialmente pelaCLI com versão20261016020936 foi alinhado à
versão real gerada pelaManagementAPI, sem executar a migration novamente.

Publicação Edge confirmada às 03:03:46 UTC de 16/10 pela Management API do
projeto autorizado: `arkhen-backend` e `arkhen-catalog-sync` estão `ACTIVE`,
versão9, com atualização às 03:03:24.934 UTC. A nova credencial CI autorizada
foi usada apenas para esse deploy, sem alterar a credencial administrativa SQL.
A tentativa anterior havia sido recusada HTTP403 por ausência de
`edge_functions_write`; esse bloqueio de publicação Edge foi resolvido.

Conferência remota às 02:27:49 UTC: RLS nas três tabelas, RPC somente servidor,
registry legível por autenticados, staging privado, publicador legado sem
EXECUTE, somente `epg_cache_versions` no Realtime EPG, cron minuto ativo e
intervalo21.600s. O registry legado conserva760 canais; há zero manifests e zero
fontes cifradas vigentes naquela leitura. Não houve primeira captura nova
comprovada por essa conferência. Fonte cifrada é requisito do coletor Edge;
RPC de serviço direta e worker local autenticado têm requisitos próprios e não
dependem dessa fonte cifrada. O deploy confirma código publicado, sem certificar
coleta EPG posterior, sincronização da biblioteca ou reprodução.

## Evidência de partida

Leitura administrativa do projeto autorizado `wnicimkmzswksaqdtgdv`, às
02:04:53 UTC de 16/10: fonte WPLAY com intervalo EPG de 300 segundos, constraint
60–3.600 segundos, crons de fila/coletor ativos a cada minuto, estimativas de
760 caches e 50.328 programas. As duas tabelas EPG estavam no Realtime.
A consulta seguinte de cobertura/jobs retornou HTTP 544 por timeout de conexão;
não foi repetida. Não existe medição atual de latência da nova projeção.

O coletor anterior publicava lotes100 diretamente e baixava novamente a origem
em cada retomada. `epg_programs` faz upsert sem reconciliar programas removidos;
por isso a leitura nova usa o payload canônico de `provider_epg_cache`.

## Coleta e publicação

- Cadência global de 21.600 segundos, com lease/deduplicação da fila existente.
- `arkhen_epg_snapshot_state`, `arkhen_epg_snapshot_stage` e
  `arkhen_epg_snapshot_publish` são RPCs exclusivas do servidor.
- Um candidato privado persiste o guia inteiro sanitizado, hash e contagens
  antes de ficar `sealed`. Publicação copia os payloads de todos os canais e
  troca `epg_cache_versions` na mesma transação. Falha mantém o snapshot público.
- Retomadas seladas não abrem/decriptam a fonte nem consultam WPLAY. A captura
  pode ser repetida pelo retry central limitado quando a falha ocorreu antes de
  confirmar o staging; não há garantia de exatamente uma entrega HTTP nesse caso.
- A publicação não atualiza os programas históricos normalizados. Candidatos
  publicados conservam o manifesto e descartam o blob privado redundante.
- A fonte cifrada pode ser retida por até 6h30, sempre limitada pela expiração
  real informada pelo JWT e pela conta. Isso não renova token nem autenticação.
  Expiração anterior a 6h pode impedir a próxima coleta até nova autenticação.
- Leituras do guia não enfileiram coleta. O ramo EPG do worker legado usa as
  mesmas RPCs atômicas e a mesma fila global.

## Projeção e contrato

`CloudRuntime.tvGuide(state, {ids:null, includeAdult:false,
timeZone:'America/Maceio', fresh:false})` usa a RPC de servidor
`arkhen_tv_guide(p_provider_key,p_scope_hash,p_channel_ids,p_include_adult,p_time_zone)`.
O runtime compartilha leituras por provedor/escopo/permissão adulta/fuso, com
guardas de conta, geração de autenticação, epoch cloud e estado do PIN.

O SQL consulta o catálogo live publicado, calcula anterior/agora/próximo com um
horário único e guarda a projeção privada por minuto/boundary. A seleção de IDs
ocorre depois do cálculo compartilhado. Fusos aceitos: America/Maceio,
America/Sao_Paulo e UTC. Nunca fixar a quantidade observada de canais no cliente.

Envelope: `schemaVersion`, `revision`, `projectionVersion`, `asOf`, `serverTime`,
`timeZone`, `nextRefreshAt`, `sourceNextRefreshAt`, `snapshotFetchedAt`,
`snapshotExpiresAt`, `horizonEnd`, `stale`, `legacySnapshot` e `channels` indexado
pelo ID nativo. `serverTime` é renovado em cada resposta, incluindo cache;
`asOf` continua sendo o instante real do cálculo SQL.

O corte semeia um registry explicitamente legado a partir dos caches existentes:
`legacySnapshot:true`, `stale:true`, expiração já vencida, horizonte nulo e zero
programas certificados como captura completa. Isso permite ler programação
existente durante a transição sem alegar publicação íntegra de uma coleta nova.
O primeiro candidato completo substitui essa revisão e limpa a marca legada.

Canal: `status`, `list` com até 3 programas, `window.previous/current/next`,
`progressPercent`, `elapsedSeconds`, `remainingSeconds` e `nextChangeAt`.
Programa: `title`, `description`, `start`, `end`, `startLabel` e `endLabel`.
Horários são absolutos; rótulos vêm do SQL. Lacuna retorna `current:null` e
progresso nulo. Sobreposição escolhe o programa iniciado mais recentemente;
o próximo início também encerra a validade da projeção corrente.

Extensão local da grade em 16/10/2026: `window.afterNext` acrescenta o segundo
programa futuro real, sem alterar o `list` legado. A projeção do provedor e a
compatibilidade local também entregam `schedule` sanitizado, ordenado e limitado
a 128 eventos por canal para as próximas 24 horas, incluindo o atual mesmo
quando começou antes. RPCs antigas continuam aceitas; uma janela de até 120 ms
permite preferir a outra projeção já iniciada com a programação ampliada. Se a
captura ainda estiver pendente, `schedulePending:true` e `retryAfterMs:5000`
pedem uma nova leitura global; falha concluída não mantém esse retry curto.
Isso não afirma atualização do SQL ou deploy remoto.

A RPC antiga resume os programas em anterior/atual/próximo, mesmo quando
`provider_epg_cache.payload.list` contém eventos posteriores. O conector local
agora amplia essa resposta com `TvGuidePublishedSchedule`: confere o registry
antes/depois da leitura em lotes de até 80 IDs, exige a mesma revisão e
timestamps da captura não legada e conserva a whitelist de canais da RPC.
Um cache limitado por provedor/escopo/revisão conserva as listas sanitizadas;
novos IDs de uma abertura com outro PIN não são considerados carregados por
engano. Janelas e progresso originais permanecem; `afterNext` é encontrado
depois da âncora exata de `window.next`, e a seleção usa `asOf`, não o relógio
renovado de entrega.

Para resposta legada, o conector usa a projeção inteira do leitor legado já
existente, com revisão própria, `legacySnapshot/stale/partial` preservados e
canais filtrados pela whitelist da RPC. Essa captura não é promovida a
certificada, nem tem programas mesclados em outra revisão. Uma alternativa
precisa acrescentar eventos reais e preservar os slots atuais/próximos
utilizáveis; possuir apenas um array `schedule` não demonstra programação
adicional. A espera extra é limitada a uma janela de 120 ms; a releitura
global de cinco segundos só persiste enquanto a expansão está pendente.

Essa alteração é no backend Node: recarregar os arquivos do navegador não
reimporta os módulos do processo `server.mjs`. O reinício do servidor executa
o encerramento das sessões em memória. A compilação estática não comprova
ativação dessa versão no processo em execução nem disponibilidade de eventos
além dos que existem na fonte.

Em Minha lista, número e canal ficam fixos durante a rolagem horizontal. Uma
régua comum posiciona os programas por início e duração absolutos. O relógio e
a linha visual usam `serverTime` com tempo monotônico decorrido e o `timeZone`
do guia; eles não escolhem o programa atual nem recalculam seu progresso.
Desde o ajuste local de 16/10/2026, a apresentação abre no início em
"Com rolagem", com escala mínima de 400 px por hora no desktop e 360 no móvel,
e dimensiona o eixo pelos eventos efetivamente recebidos,
sem uma reserva mínima de seis horas. O início considera os programas atuais
com recorte de passado próximo (90 minutos antes do arredondamento); o fim
considera eventos que intersectem as próximas 24 horas. Títulos e horários
reais continuam disponíveis mesmo quando o bloco é recortado no eixo.
"Ajustar à tela" e "Ir para agora" são ações manuais; atualização do guia não aciona
rolagem até o relógio. O painel de detalhes mostra o título completo ao
selecionar um programa por ponteiro, toque ou teclado. Selecionar o programa
mostra seus detalhes; o botão do canal mantém a ação de assistir.
A lista cresce conforme a quantidade de canais, sem altura máxima nem
rolagem vertical interna. A página é o único eixo de rolagem vertical;
a rolagem horizontal da grade e suas colunas fixas permanecem. Os blocos
preservam a duração real; programas muito curtos não sobrepõem os vizinhos
para acomodar o título, que permanece disponível no painel de detalhes.
Não são criados eventos para preencher lacunas nem se declara que uma
projeção com somente atual/próximo contém toda a programação do provedor.

`revision` identifica a captura de 6h; `projectionVersion` identifica a projeção.
`nextRefreshAt` é a próxima atualização do cálculo, não o horário da coleta.
Na falha/revalidação, o runtime pode devolver a última projeção com `stale:true`
e `retryAfterMs` de 1.000/5.000. O consumidor respeita esse backoff mesmo quando o
`nextRefreshAt` antigo está no passado; não prolonga programas nem calcula
progresso ou promove o próximo programa localmente.

O registry é protegido pelo helper RLS de provedor/escopo existente. Candidatos
e projeções têm RLS e acesso apenas do servidor. Eventos Realtime carregam
somente o registry; não replicam grades ou programas. O cron do relógio faz
cálculo no banco, sem chamar WPLAY. A API aplica também autorização atual e
filtros da conta após o cache global, sem contaminar sua identidade compartilhada.

## Corte e verificação

1. Conferir projeto, migrations existentes e ausência de lease EPG ativa com
   leitura curta; a migration recusa corte com lease vigente e tem lock_timeout de 3s.
2. Revisar o diferencial SQL e coordenar Edge/coletor/worker/API/cliente. O
   publicador legado perde EXECUTE para service_role para impedir escritas sem
   registry. Uma captura global inicial é enfileirada, sem apagar caches antigos.
3. Aplicar a migration somente após revisão do responsável principal. Publicar
   Edge/backend e servir os consumidores do contrato novo de forma coordenada.
4. Conferir grants/RLS, publicação Realtime, cron, manifesto e primeira revisão
   por SELECT diagnóstico limitado. Medir duração real antes de afirmar latência.
5. Estado remoto instável ou ausência de fonte válida são relatados como tal;
   não repetir timeouts longos nem declarar fixture como execução real.

Nesta etapa foram usadas somente revisão estática, `node --check` e
`git diff --check`; não houve teste de UI, browser, playback ou reinício.

Referências: [Postgres Changes e custo por assinante](https://supabase.com/docs/guides/realtime/postgres-changes#scaling-postgres-changes),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Supabase Cron](https://supabase.com/docs/guides/cron),
[horário consistente no PostgreSQL](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).
