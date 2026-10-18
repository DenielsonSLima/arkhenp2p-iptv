# Séries

## MEM-SERIES-007 — Descoberta limitada e primeira unidade de métricas

Estado: migrations aplicadas e conferidas; worker versão 8 ACTIVE; conclusão operacional parcial. Data: 16/17 de outubro de 2026.

Métrica inicial podia esgotar o orçamento cooperativo durante inicialização antes da primeira busca. Versão `20261017011924` inicia relógios por fase, tenta a primeira unidade, alterna fontes e evita preparar publicação enquanto a descoberta a impede. Preserva gate/publicação/ACK numa instrução, prazo externo de 8 s e snapshot público anterior. Às 01:26:21 UTC, checkpoint tinha 5 unidades e cursor iniciado, mas nenhuma publicação global concluída.

Versão `20261017012209` cria descoberta por chave/geração, materializando até 500 candidatas antes do join, incluindo sonda; retorna mudanças e continuação reais. Página, upsert e cursor são atômicos. Geração nova é elegível imediatamente no próximo ciclo; concluída aguarda 15 minutos. RPC antiga permanece disponível. Worker foi publicado depois do schema, sem execução manual como teste.

Fontes: [manutenção](../supabase-maintenance-review-20261017.md) e [evidências integradas](../otimizacao-sistema-supabase-20261016.md). Evidência de sintaxe, revisão independente, hashes/grants e ciclos naturais; sem certificação de contagem final ou CPU.

## MEM-SERIES-006 — Métricas incrementais com publicação global

Estado: schema remoto aplicado e conferido; processamento inicial ainda depende dos ciclos naturais. Data: 16/10/2026, readback em 17/10 UTC.

A agregação integral ainda expirou em 45 s após a primeira otimização. O cálculo passou a buscar um IMDb por índices e gravar deltas privados em lotes curtos. Invalidações reconhecem exatamente IMDb/transação; eventos globais incluem revisão para distinguir TRUNCATE repetido na mesma transação. Descoberta por cursor inclui títulos antigos para remover extintos e preserva commits fora de ordem.

Resultados parciais nunca alimentam o status público: gate, métricas e timestamp global compartilham uma instrução/transação quando a descoberta e as pendências terminam. A versão pública anterior permanece disponível durante o bootstrap, que pode exigir muitos ciclos. Orçamento cooperativo entre títulos não limita uma unidade excepcionalmente grande; o deadline externo ainda é necessário. Não houve teste funcional ou certificação de contagem/carga remota nesta etapa.

Fonte: [relatório](../supabase-load-optimization-20261016.md), `supabase/migrations/20261017003447_arkhen_marker_metrics_atomic_batches.sql`; revisão estática por agente independente e readback de hashes/configuração.

## MEM-SERIES-005 — APIs temporais e duração separadas

Estado: histórico de implementação local. Data: 16/10/2026.

Leitor e conector cloud de marcadores residem em `web/serie/marcadores/`; duração explícita/apresentação em `web/serie/duracao.js`. O sync manual foi separado em `lib/serie/marcadores/`, com conectores, normalização, exportação e publicação próprios. A Edge mantém pipeline/lease/checkpoints existentes e conectores HTTP, SkipDB, IntroDB e dump separados. Scheduler local sem consumidor foi removido, sem outro cron ou loop concorrente. Manifests e licenças foram preservados.

O adaptador OTT deixou de atribuir à série a duração da primeira fonte/episódio e não inicia sonda para isso. Duração do episódio pertence ao episódio. Referências comunitárias de abertura/créditos continuam sem certificação audiovisual automática da edição.

Fontes: [APIs temporais](../../lib/serie/marcadores/README.md), [revisão integrada](../architecture-review-wplay-20261016.md), `web/serie/marcadores/`, `lib/wplay/ott/provedor.mjs`, `supabase/functions/series-markers-sync/conectores/`. Evidência: 107 testes sintéticos da frente temporal e conjunto integrado de 400 aprovados; sem mídia, navegador, operação remota ou publicação da Edge.

## MEM-SERIES-003 — Catálogo, detalhes e estado isolados

Estado: em implementação — integrada localmente e verificada com dados sintéticos; publicação pendente. Data:16/10/2026.

`web/serie/` possui serviços reais de detalhes, busca tipada, escopo, leitores/cancelamento, cache TanStack e eventos de catálogo/biblioteca. A aba reutiliza o repositório existente; metadados compartilham leitura por série com cancelamento independente e cache limitado64. Conta/geração/PIN/ocultações Séries invalidam leitores antigos; anexar o bootstrap cloud à mesma conta não encerra a prévia selecionada. URL de reprodução exige ID nativo do episódio, formato e tentativa válidos, sem sonda de mídia.

`SeriesSearch` delega à única RemoteSearch com tipo Séries. O aplicativo desativa apenas nesse tipo o fallback de snapshot local; ordem/contagens/paginação vêm da RPC. O QueryClient existente é injetado, sem outra instância. Cancelamento/reset/limpeza da busca compartilhada agora atingem somente `arkhen-global-search`, preservando caches e leituras de outros domínios.

`SeriesSupabase` projeta a CloudLibrary autenticada existente e confere conta/biblioteca/usuário/provedor/partição antes de entregar favoritos, histórico ou episódios. Não possui Auth/socket/outbox/store paralelo; progresso adulto continua bloqueado. Eventos de progresso invalidam apenas a projeção privada, não catálogo ou mídia. Eventos de catálogo rejeitam outra partição/revisão antiga.

Fontes: `web/serie/{orquestrador,services,busca,scope,hooks,tanstack-query,realtime,supabase}.js`, `web/remote-search.js`, [mapa de Séries](../../web/serie/README.md). Prova:23 testes sintéticos em `tests/series-catalog.test.mjs` e `tests/remote-search.test.mjs`; sem conta real, navegador, mídia, operação remota ou publicação nesta frente.

## MEM-SERIES-004 — Integração da apresentação, player e backend

Estado: histórico de implementação local. Data:16/10/2026.

Prévia, temporadas, episódios, miniaturas, progresso e sequência têm implementações canônicas em `web/serie/`; os antigos módulos de raiz foram removidos após migração dos consumidores. Áudio, legenda, resolução, buffer e retomada são encaminhados pelo aplicativo/PlayerTools às políticas Séries. Uma única sessão, vídeo ativo, transporte, seek, biblioteca e grafo de áudio permanecem compartilhados. O formato/chaves do progresso foi preservado. Uma atualização manual invalida os novos caches sem permitir repovoamento pela revisão anterior.

`lib/serie/{orquestrador,catalogo,metadados}.mjs` atende as fatias Séries das rotas existentes. Metadados não sondam o primeiro episódio para atribuir duração à série. Testes do `createApp` conferem o despacho real, o contrato de temporadas/episódios, parental por sessão e preservação dos contratos de Filmes/TV, com provedor simulado e mídia proibida pelo próprio harness.

Fontes: [registro integrado](../series-modularization-20261016.md), `web/app.js`, `web/player-tools.js`, `lib/app-server.mjs`, `tests/{serie-app-integration,serie-backend,serie-player,series-progress-entry}.test.mjs`. Evidência:166 testes sintéticos aprovados, bundle local e23 recursos HTTP200 após reinício; catálogo Séries sem sessão HTTP401. Sem navegador, mídia, banco, deploy ou certificação de produção. Falhas operacionais anteriores ficam em etapas posteriores por decisão do usuário.

## MEM-SERIES-001 — Temporadas, episódios e progresso

Estado: contrato. Data: 15/10/2026.

Séries possuem catálogo, temporadas, episódios e sequência próprios. Duração de um episódio não representa a série inteira. Progresso pertence à conta/episódio e não entra no catálogo ou na memória técnica. Conteúdo adulto não produz histórico ou Continuar assistindo. Respostas atrasadas precisam respeitar a conta e seleção atuais.

Fontes: [reprodução de séries](../series-playback.md), [progresso por episódio](../episode-progress.md), [privacidade adulta](../adult-progress-privacy.md), `web/serie/sequencia.js`.

## MEM-SERIES-002 — Marcadores e prova da edição

Estado: contrato com correção posterior da política de automação pelo usuário. Atualizado: 17/10/2026.

Referências comunitárias não certificam a edição WPLAY. Em 17/10 o usuário corrigiu a interação inicialmente manual: o padrão deve contar 5 segundos e pular automaticamente introdução e créditos também com os horários das APIs, permitindo cancelar ou agir imediatamente. Essa autorização substitui a exigência anterior de verificação audiovisual para automatizar referências, mas não altera sua classificação como comunitárias. Proximidade de duração e concordância entre fontes não provam limites audiovisuais. Preservar IMDb/ano, temporada/episódio, duração e IDs nativos; anime e adaptação homônima não são equivalentes. Diferenças de até 5s entre fontes são toleradas; acima disso sinalizar divergência sem média ou consulta extra somente para comparar.

Fontes: [verificação de marcadores](../marker-playback-verification.md), [fontes de séries](../series-marker-providers.md), [registro de engenharia](../engineering-recovery.md), `web/serie/marcadores/orquestrador.js`.

## MEM-SERIES-005 — Referências sob demanda

Estado: implementado e ativado localmente; prova audiovisual pendente. Data: 17/10/2026.

Player consulta `GET /api/series/episode-markers` somente após `playing`, com identidade do episódio ativo. SkipDB principal com duração/ajuste desativado, IntroDB somente para tipos ausentes; cache 24h/1h/60s em servidor e dispositivo, sem varredura de temporada. A rota confere sessão, intent/generation ativa e parental; reset/troca/saída descartam respostas atrasadas. Referências permanecem separadas das marcas verificadas, mas alimentam a contagem automática de 5 segundos autorizada posteriormente; preservam fim de outro e cena pós-créditos. Coleta cron global foi desativada no projeto autorizado e ambos jobs de coleta/métricas conferidos inativos.

Fontes: [implementação e evidências](../series-markers-on-demand-20261017.md), `lib/serie/marcadores/{rota,sob-demanda}.mjs`, `web/serie/marcadores/{sob-demanda,referencia}.js`, `tests/series-markers-on-demand.test.mjs`. Evidências: 101 testes, bundle, resposta HTTP real das APIs públicas e cache; Safari indisponível. Não certifica cobertura/precisão das edições ou deploy de produção.

Correção posterior da interação em 17/10: `web/episode-skip.js` usa a contagem existente para referências, respeita preferências, suspensão em pausa/buffer/seek, cancelamento e pós-créditos, e impede reenvio de seek pendente. 82 testes automatizados da alteração aprovados e bundle válido; módulos conferidos por HTTP local sem reiniciar servidor. Fontes: `tests/episode-skip.test.mjs`, `tests/series-playback.test.mjs`, `tests/series-playback-preferences-view.test.mjs`. Sem reprodução audiovisual nesta etapa.
