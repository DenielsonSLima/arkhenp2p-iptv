# Infraestrutura compartilhada

## MEM-SHARED-020 — Ícones do Safari

Estado: correção local; inspeção estática, sem confirmação visual no Safari. Data: 18/10/2026.

Os favicons existentes ficavam somente em `assets/brand/`. Foram adicionadas cópias na raiz para `/favicon.ico` e `/apple-touch-icon.png`, mantidas pelo gerador, além de máscara monocromática para abas fixadas. O documento declara os tamanhos PNG e ICO, SVG com `sizes="any"` e revisão de URL atualizada. A ausência dos endereços padrão e da máscara foi verificada no código; não foi isolada como causa exclusiva da ausência relatada pelo usuário. Não houve testes ou navegador nesta etapa.

Fontes: `web/index.html`, `tools/build-brand-assets.py`, [arquivos da marca](../../web/assets/brand/README.md) e [contrato Apple](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/pinnedTabs/pinnedTabs.html).

## MEM-SHARED-019 — Perda de sessão e interface

Estado: corrigido localmente; 55 testes internos. Data:17/10/2026.

Sessões em RAM não sobrevivem ao reinício. UI ignorava 401 e connected:false. Guarda agora confirma perda, invalida tarefas e mostra entrada, preservando falhas transitórias e login novo. Sem reinício real; frontend compatível com backend anterior. Fonte: [evidência e limites](../session-loss-reconciliation-20261017.md).

## MEM-SHARED-018 — Logs Query e diagnóstico sem varreduras recorrentes

Estado: revisão de três agentes, documentação oficial e código; regra operacional aplicada, autoria histórica e redução futura não comprovadas. Data:16/10/2026 local,17/10 UTC.

Logs Query acumula bytes varridos ao ler logs; ingestão e armazenamento são medidores distintos. Consultas repetidas podem contar os mesmos registros. Não foi encontrado consumidor de Logs Query no runtime/ferramentas/SQL auditados. Diagnóstico de console e SQL PostgreSQL não são consultas ao histórico de logs. O MCP oficial usa24h se o intervalo for omitido; uma janela explícita pequena evita esse padrão. Isso não identifica quem consumiu a franquia histórica.

O APK tem cache em disco/RAM e diagnósticos Xlog/CrashReport; o cliente não revela o backend do fornecedor. Cache do produto reduz trabalho, mas não interrompe consultas administrativas externas. `AGENTS.md` passa a priorizar saúde/contadores limitados, sem polling de logs; consulta excepcional exige escopo/tempo explícitos e reutilização do resultado. Regra local não é bloqueio técnico de outras ferramentas. Avaliar incremento do medidor considerando o atraso de atualização, sem esperar queda do total acumulado.

Fonte:[revisão, evidências e procedimento](../supabase-log-query-review-20261016.md). Sem consulta a logs remotos, alteração de infraestrutura, testes, navegador ou execução do APK nesta etapa.

## MEM-SHARED-017 — Recuperação de identidade e projeções privadas

Estado: schema/código ativados, recuperação observada pelo usuário; estabilidade prolongada não comprovada. Data:17/10/2026 UTC.

Bind14444 evita inserts no vínculo existente, mantendo conflitos/validação/Auth; limites SQL3s/lock500ms/transporte5s. Home/Filmes reutilizam prova WPLAY válida24h. recover retornaPromise e indisponibilidade repete a partir30s. Na reincidência, logprecondition CLOUD_SESSION_MISSING/0ms confirmou falha antes da RPC. Após reinício observado01:57UTC, saúde/lookup voltaram; capturas e confirmação do usuário demonstraram sugestões/canais carregados. SQL atual de Filmes passou testes locais; nenhum ranking foi refeito nessa investigação. Testes internos autorizados, sem navegador/mídia.

Fonte: [diagnóstico, recuperação e limites](../home-movie-recovery-20261017.md).

## MEM-SHARED-016 — IOWait dominante e recuperação dos serviços

Estado: intervenções/reinício/retomada conferidos; causa inicial exata e estabilidade prolongada não isoladas. Data:16/10/2026, leituras17UTC.

IOWait dominou apesar de pouco User/System. Janela com jobs contidos mostrou pouco I/O PostgreSQL e sem crescimento temporário; não provou scan contínuo, swap ou falha de host. Compromisso de memória não equivale a RAM física ocupada. Limpeza passou a limitar candidatas e revalidar proteções; métricas evitam trabalho sem publicação elegível. Definições/hashes conferidos.

Lookup504 antecedeu bind e Auth/REST estavam indisponíveis: otimizar bind não corrige etapa anterior. API de reinício recusou permissão; usuário reiniciou no painel, postmaster22h57local. Sete jobs antes ativos foram retomados, quatro pausas mantidas. Às23h04 serviços saudáveis e17 execuções naturais bem-sucedidas; dois diários ainda fora da cadência. Despachante não prova Edge concluída. Captura23h05 mostrou36,27% e fim do patamar de IOWait. Reinício, correções e pausas coexistiram; não atribuir causa exclusiva nem alegar vazamento/créditos/swap sem evidência.

Fonte: [incidente e detalhes preservados](../supabase-cpu-recheck-20261016.md). Leituras remotas, capturas e revisão estática, incluindo Astra solicitado. Sem testes/navegador/mídia nessa frente.

## MEM-SHARED-015 — Cache por revisão e EPG sob demanda

Estado: implementação local integrada; três migrations e worker remoto conferidos; incidente de carga ainda aberto. Data: 16/10/2026, leituras em 17/10 UTC.

O cache diário existente agora apresenta os dados antes de uma verificação compacta no arranque. Mesma publicação confirma `verifiedAt` separado sem regravar bytes/`savedAt`; versão diferente exige snapshot completo e atômico. Falhas preservam conteúdo, mantêm verificação pendente e usam backoff. Realtime reconhece domínio/revisão/UUID; snapshot antigo usado como fallback não confirma atualização. Conta, ticket e PIN são revalidados também após IndexedDB.

TV deixou de regravar a grade pública por minuto: RPC seleciona canais elegíveis e reutiliza janelas privadas até revisão/fronteira, com progresso no servidor e união dos consumidores visíveis. Clock está inativo; coleta/publicação real e fallback autorizado continuam. Métricas usam orçamento por fase para não ficar sem primeira unidade; descoberta limita candidatas antes dos joins. Migrations efetivas `20261017011816`, `20261017011924`, `20261017012209`; worker de marcadores versão 8 ACTIVE, outros preservados. Sintaxe/bundles e readbacks não certificam CPU ou experiência final. Bootstrap passou de 1 para 5 unidades, sem publicação global concluída; ainda ocorreram timeout de privacidade e falhas administrativas.

Fontes: [etapas e evidências](../otimizacao-sistema-supabase-20261016.md), [catálogo](../catalog-revalidation-20261016.md), [TV](../tv-epg-on-demand-20261017.md), [manutenção](../supabase-maintenance-review-20261017.md). Sem testes, navegador, mídia ou nova publicação do site. Servidor local recarregado na porta 4173.

## MEM-SHARED-014 — Saturação persistente e limites do diagnóstico

Estado: leitura remota datada; incidente aberto, sem nova mutação remota nesta rechecagem. Data: 16/10/2026, 22h12–22h15 locais (17/10 UTC).

Vários crons falharam simultaneamente com `startup_timeout`; isso ocorre antes da execução normal das funções e não identifica a causa sistêmica. TV e limpeza continuam com duração variável. Contadores cumulativos de SQL e uma amostra sem consultas ativas não medem nem comprovam recuperação da CPU. Limites de workers isolados não explicam falta de conexões do Cron; tempos de I/O zerados são inconclusivos se a medição de tempo estiver desativada. As configurações datadas ficam no relatório operacional, fora deste corpus.

Métricas de CPU pela Management API responderam 403; não usar esse erro como CPU zero. A função `pg_stat_statements(false)` permite observações numéricas sem recuperar o arquivo de textos SQL. Antes de nova intervenção, confirmar autoria/estado das migrations concorrentes de TV e marcadores que surgiram durante a rechecagem; arquivo local não comprova aplicação remota.

Fonte e limites: [rechecagem de CPU](../supabase-cpu-recheck-20261016.md), scripts de operações citados nesse documento. Sem testes, navegador, restart ou prova de redução sustentada.

## MEM-SHARED-013 — Carga ociosa e redução de reconsultas

Estado: implementação local e alterações remotas conferidas por definição; resultado operacional limitado à janela observada. Data: 16/10/2026, com readbacks em 17/10 UTC.

As capturas de Logs Query representam bytes varridos por consultas de logs, não crescimento do banco. Estatísticas PostgreSQL localizaram manutenção recorrente sem espectadores: limpeza de gerações, projeção TV, métricas e agendadores. Limitar somente linhas excluídas não limita o trabalho para encontrar candidatas; deadlines externos impediram aceitar como concluídas duas primeiras versões que ainda expiravam.

Limpeza conserva uma chave lógica descoberta em chamada anterior, gira tabelas por minuto e consome pequenos arrays de TIDs bloqueados na mesma transação, rechecando as proteções na exclusão. Métricas usam deltas privados e publicação global atômica. Workers não iniciam cadeias de continuações por padrão. Backfill Home sem pendências permanece pausado; novos metadados continuam cobertos pelo trigger. Nenhuma recuperação de CPU decorre apenas da confirmação de schema ou estado administrativo.

No código local, progresso/Realtime aplicam linhas confirmadas, foco saudável não refaz bootstrap e a aba oculta adia revalidações. Atualização de catálogo é agrupada por partição/domínio; enfileirar não apaga snapshots válidos. Falha não renova o TTL diário e reload compartilha cooldown. Biblioteca privada, leases, gerações e domínios permanecem isolados. A redução do cliente depende de carregar/publicar o código atualizado; não houve teste de aplicativo ou mídia nesta etapa.

Fonte e limites: [relatório de otimização](../supabase-load-optimization-20261016.md), migrations e arquivos citados nele. Evidência: leitura de definições/cron e execuções naturais, revisão independente e sintaxe JavaScript. Sem benchmark, teste automatizado, restart de Supabase ou aumento de plano.

## MEM-SHARED-012 — Conexão WPLAY por domínio

Estado: histórico de implementação local. Data: 16/10/2026.

`lib/wplay/` concentra a conexão real: orquestrador/factory, configuração, autenticação nativa e OTT, codec RPC, conector Supabase e composição da reprodução. O conector reutiliza o gateway/CloudRuntime existentes, sem novo Auth ou pool. Serviços `ao-vivo`, `filmes` e `series` recebem o mesmo cliente autenticado; o kernel VOD conserva gerações independentes. Rotas de produto continuam em `lib/{tv,filmes,serie}/`; frontend/player/configurações/início mantêm seus proprietários. Sessão e STOP/generation não foram duplicados.

Consumidores foram migrados para os módulos canônicos antes da remoção dos arquivos de raiz e de 14 fachadas TV/player/Filmes. Algoritmos antigos de Home usados somente por testes foram retirados de `web/` para fixtures. Um fallback ativo de ordenação no início permanece pendente. A sessão por processo na Vercel e a disponibilidade Supabase não foram resolvidas pela extração.

Fontes: [revisão integrada](../architecture-review-wplay-20261016.md), [camada WPLAY](../../lib/wplay/README.md), `lib/app-server.mjs`, `tests/wplay-connection.test.mjs`. Evidência inicial: 400 testes sintéticos selecionados e bundles navegador/servidor. A [limpeza posterior](../epg-architecture-cleanup-20261016.md) atualizou os contratos de testes legados Auth/EPG. Sem navegador, mídia real, banco, migration ou deploy nesta etapa.

## MEM-SHARED-011 — Cloud no entrypoint hospedado

Estado: correção local e testes sintéticos aprovados; sem novo deploy ou configuração remota. Data: 16/10/2026.

A correção anterior do export Vercel abriu a tela de entrada, mas conservou `cloud=null` no modo importado. O runtime hospedado agora possui fábrica explícita para a configuração privada `ARKHEN_SUPABASE_CONFIG`, validada no mesmo projeto/contrato existente. Ausência ou erro conserva a entrada e emite somente código sanitizado; não busca `.local`. Imports comuns de testes permanecem sem nuvem/arquivos privados, e execução local direta conserva a configuração local. Também se passa configuração de conexão explícita no modo importado para evitar leitura implícita do arquivo privado pelo `createApp`.

Fonte: `server.mjs`, `lib/runtime-cloud-config.mjs`, `tests/vercel-hosting.test.mjs`, [hospedagem](../../README.md#publicação-e-hospedagem). Nove testes de hospedagem passaram; seleção final com 14 arquivos somou 146 aprovações. A memória de sessão por processo e a indisponibilidade real do banco são limites separados; configurar a fábrica não os resolve. Não copiar configuração privada real para o bundle ou para a memória.

## MEM-SHARED-009 — Remoção do experimento local e recuperação limitada

Estado: implementação local; verificação sintética, sem reprodução ou nova publicação. Data: 16/10/2026.

O usuário determinou excluir a ponte experimental Android/P2P e manter os serviços WPLAY. Foram removidos runtime, bridge, comandos de preparação/inicialização, ferramentas exclusivas e caminhos de seleção no servidor. O APK de referência foi preservado. O modo web recebe HTTP autorizado do provedor e pode consultar o transporte OTT da mesma conta para TV; nunca converte `tvbus://` sintaticamente. Um servidor anterior fora iniciado com a engine local forçada e endpoints sem serviço disponível; esse processo foi encerrado e `npm start` voltou ao caminho normal.

MP4 nativo aberto pelo Shaka não passa pelo NetworkingEngine. A falha terminal agora desanexa `src`, consulta uma vez o diagnóstico da tentativa e impede fallback de codec em 429; o prazo de retomada segue até o botão de retry. O encerramento invalida callbacks antigos e protege o elemento de vídeo de uma reprodução posterior. O proxy conserva cooldown e deixa de repetir diagnóstico para cada leitor bloqueado. Isso limita ciclos de falha; não certifica disponibilidade atual da mídia.

Bootstrap de biblioteca possui espera progressiva por conta/geração, sem contornar uma falha transitória via recover. A faixa Home de quatro canais mantém a projeção válida da mesma conta e mostra espera/erro, em vez de desaparecer durante indisponibilidade cloud. Most watched e três recentes continuam calculados na RPC; nenhum ranking migrou para o cliente.

Fontes: [documentação WPLAY atual](../wplay/README.md), `lib/wplay/conexao/reproducao.mjs`, `lib/wplay/ao-vivo/resolver-web.mjs`, `web/player/motores/shaka/`, `web/hls-error-handler.js`, `lib/cloud-runtime.mjs`, `web/inicio/lista-canais/`. Treze arquivos de teste somaram 131 aprovações; outra seleção somou 27. Não representam suíte completa, teste audiovisual ou implantação desta rodada.

## MEM-SHARED-010 — Incidente de CPU e banco indisponível

Estado: observação remota datada e pausa pontual confirmada; causa integral não determinada. Data: 16/10/2026.

A configuração do backend aponta para o projeto autorizado, mas conexão recusada ao PostgreSQL e timeouts REST/SQL foram comprovados. O status administrativo `ACTIVE_HEALTHY` não demonstrou banco acessível. Imagens do usuário mostram CPU 99%, serviços Unhealthy, timeouts e desligamento. A leitura do cron confirmou `arkhen-home-identities` ativo a cada minuto, com lote 1.000; a captura registra aproximadamente 15,9 s nessa chamada. Não houve restart de Supabase pela equipe.

A pausa pontual foi confirmada em readback posterior por volta de 23h04 UTC: job 9, nome/cadência preservados, `active=false`. Antes disso houve recusa e timeouts; uma mutação persistiu apesar de a resposta expirar. A confirmação da pausa não comprova queda de CPU ou restauração do banco. Ler o estado antes de repetir ou reativar. Não aumentar timeout global, apagar catálogo ou alterar RLS por hipótese. A leitura posterior mediu mídia com 119,97 MiB, aproximadamente metade em índices; referências de arte com 35,31 MiB, dos quais 21,33 MiB em índices. Tuplas vivas/mortas e datas de manutenção retornaram zeros/nulos, sem certificar vazio ou ausência de bloat. Atividade dos jobs ainda expirou. Eram uma tabela acima de 100 MB, não duas.

Há riscos locais de repetição integral após timeout e de retenção de gerações/preparações antigas; são amplificadores possíveis, não atribuição medida de CPU. As funções de Home não fazem recursão direta: o trigger de identidade responde a metadados/tipo, enquanto o backfill altera `home_identity`.

Fontes: [incidente e scripts](../supabase-incident-20261016.md), [auditoria de jobs e retenção](../home-identity-cron-20261016.md). Nenhum dado pessoal ou texto bruto de consultas foi incorporado à memória.

## MEM-SHARED-008 — Inicialização na Vercel

Estado: correção publicada; abertura da tela de entrada verificada em produção. Data: 16/10/2026.

O build concluía, mas a função falhava ao importar `server.mjs`: os logs de execução exigiam um export default de função ou servidor. A entrada agora exporta o mesmo `http.Server` por default; somente execução direta abre a porta local. A política de Host permite localhost e autoridades exatas da configuração, sem curinga e sem confiar em headers encaminhados. A guarda de mesma origem das APIs permanece ativa. O pacote inclui `web/**` e exclui configuração privada, arquivos de ambiente e APKs; a publicação usou staging sanitizado.

Evidência: cinco testes focados passaram (documento/estilos, hosts locais e hospedados, rejeição de origem externa e importação sem listener). Acesso remoto no Chrome confirmou o formulário, fundo e marca localmente, na prévia e no domínio de produção. A consulta dos logs da implantação corrigida não encontrou respostas 500 na janela observada. A captura do Safari não permitiu certificar toda a renderização; a comprovação visual foi feita no Chrome.

Limite: abrir a entrada não comprova autenticação, catálogo, favoritos, recomendações ou reprodução. Sessões do provedor ainda são locais a cada processo; a configuração privada Supabase requer adaptação própria para hospedagem distribuída. Não copiar configuração local privada para o pacote como solução.

Fontes: `server.mjs`, `lib/request-host-policy.mjs`, `lib/app-server.mjs`, `vercel.json`, `tests/vercel-hosting.test.mjs`, seção de hospedagem do [README](../../README.md). Diagnóstico remoto e validação de navegador realizados em 16/10/2026; logs brutos e credenciais não fazem parte da memória.

## MEM-SHARED-007 — Escolha explícita Atual/Shaka

Estado: implementação local; evidência estática, sem validação audiovisual. Data: 16/10/2026.

Configurações → Player tem somente Atual (padrão) e Shaka. Preferência por navegador é independente da conta/cloud e capturada na próxima abertura; retries/fontes preservam o motor. Shaka5.2.13 vendorizado com integridade/licença carrega sob demanda, sem novo serviço. Adapter mantém controles/faixas/posição e restringe rede às rotas locais autenticadas. Encerramento assíncrono precede nova mídia; falha conserva barreira fechada. Uma conexão remota. Destruir Shaka elimina o buffer antigo: continuidade mostra último quadro capturável, sem promessa de vídeo contínuo/menos travamentos. Sem backend/Supabase/reinício.

Fontes: [contrato e versão](../../web/player/motores/README.md), `web/app.js`, `web/player/troca-canal/continuidade/`, `web/sistema/configuracoes/`. Revisão por quatro agentes, sintaxe e bundle em memória; sem testes, navegador ou mídia.

## MEM-SHARED-005 — Bootstrap pendente e recuperação da biblioteca

Estado: corrigido no código local; inspeção e sintaxe, sem testes ou UI. Data: 15/10/2026.

Uma resposta `cloud:null` não prova ausência de configuração: a preparação do backend pode continuar após o orçamento HTTP ou falhar temporariamente. A ponte da biblioteca aguarda/reconsulta `/api/session` sem revogar Auth já validado. Recuperação de sessão existente exige a mesma `libraryId`, projeto e usuário; logout explícito ou troca de conta continuam encerrando a sessão. Não buscar identidades por nome nem misturar bibliotecas entre aparelhos.

Reconexões da mesma conta preservam a fila em memória, inclusive quando armazenamento persistente está indisponível. Um bootstrap ausente não publica snapshot vazio. Hidratação aplica somente registros recebidos e remoções explícitas com data; favoritos locais de outra `libraryId` não são importados. O código sanitizado da falha do backend permanece separado do estado de configuração. Isto não comprova bootstrap remoto nem sincronização entre aparelhos no estado atual.

Fontes: `web/cloud-app-bridge.js`, `web/cloud-library.js`, `web/cloud-outbox.js`, `lib/wplay/conector-supabase.mjs`, `lib/cloud-runtime.mjs`, `lib/account-library.mjs`, `lib/supabase-cloud.mjs`.

## MEM-SHARED-004 — Cliente Auth e leitura sem login bloqueante

Estado: corrigido no código local; revisão estática, sem UI. Data: 15/10/2026.
Reconexões conservam um cliente Auth por projeto/usuário e serializam operações,
preservando token rotacionado. Logout explícito revoga a sessão. Consultas de
busca/organização/Home/sugestões têm orçamento próprio e alternativa autorizada,
sem aguardar bootstrap dentro de uma leitura. Alternativa local de sugestões
declara source loaded-catalog e personalized false; não inventa afinidade.
Fontes: `web/cloud-library.js`, `lib/cloud-runtime.mjs`,
[lote de recuperação](../recovery-batch-20261015.md).

## MEM-SHARED-001 — Catálogo por domínio e biblioteca privada

Estado: contrato confirmado no código local. Data: 15/10/2026.

Filmes, Séries e TV compartilham primitivas, mas conservam estado, cache, lease, cursor e revisão independentes. `CatalogRepository` inclui projeto, provedor, escopo, tipo e modo adulto na chave; epochs da conta/requisição impedem commits atrasados. Prévia não substitui snapshot completo. Cache completo válido dura 24 horas; falha não renova sua idade. Favoritos e progresso não fazem parte desse cache global.

Fontes: `web/catalog-repository.js`, `web/features/catalog-feature.js`, [arquitetura](../catalog-architecture.md), [modelo de consulta](../catalog-query-models.md).

## MEM-SHARED-002 — Metadados e mídia são caminhos distintos

Estado: contrato. Data: 15/10/2026.

Supabase centraliza metadados sanitizados, catálogo, EPG, jogos e biblioteca privada com RLS. Sessão, autenticação do provedor e transporte privado permanecem no backend apropriado. Storage/CDN pode acelerar capas efetivamente publicadas e permitidas; não converte playlists autenticadas ou TVBus em mídia compartilhada. O projeto remoto autorizado é `wnicimkmzswksaqdtgdv`; confirmação do projeto não autoriza toda operação remota.

Fontes: [backend Supabase](../supabase-backend.md), [contrato WPLAY](../wplay-playback-contract.md), [Storage CDN](https://supabase.com/docs/guides/storage/cdn/fundamentals).

## MEM-SHARED-003 — Realtime e nível de evidência

Estado: contrato com evidência histórica. Data: 15/10/2026.

Catálogo usa avisos compactos de `catalog_visible_generations`; não transmitir milhares de títulos por publicação. Eventos pessoais não recarregam catálogos por progresso. Saúde remota e contagens citadas nos relatórios de 15/10 são históricas. Migration presente ou HTTP de envio não prova aplicação; readback e resultado da operação são evidências diferentes. Nenhuma validação audiovisual em massa decorre da leitura do catálogo.

Fontes: `web/cloud-library.js`, `web/shared-catalog-updates.js`, [registro de engenharia](../engineering-recovery.md), [revisão local TV/Home](../tv-home-recovery-20261015.md), [limites Realtime](https://supabase.com/docs/guides/realtime/postgres-changes).


## MEM-SHARED-006 — Login, início e abas modularizados

Estado: implementação local conferida estaticamente. Data:16/10/2026.

LoginScreen/SessionLoader/capas/fundo ficam emweb/login. SystemShell compõe
cabeçalho, navegação, busca, menu e configurações emweb/sistema; serviçosJSON,
DOM hooks e layout de catálogo são compartilhados. HomeOrchestrator compõe
services/TanStack/Realtime/banner e seis seletores emweb/inicio. Filmes/Séries
possuem abas/serviços de catálogo e MinhaLista tem seleção/renderização próprios.
A extração não migrou engineVOD, episódios ou Auth para instâncias por tela.

Foram removidas23fachadas após atualizar imports de produção/testes/ferramentas.
Reset de preferências/PIN preserva rotação; conta encerra seus leitores/relógios.
Publicação Realtime ignora TTL, valida revisionAt e não confirma null/revisão
antiga; retries1/5/15s são limitados por geração. Bibliotecas privadas mantêm
umaAuth/socket/outbox; dados de conta não entram em cache global.

Fontes: [mapa do sistema](../system-modularization-20261016.md), web/login,
web/sistema, web/inicio, web/minha-lista, web/filmes, web/serie eweb/app.js.
Prova: revisão estática ecompilação, sem UI/testes/reprodução.
