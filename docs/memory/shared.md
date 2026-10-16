# Infraestrutura compartilhada

## MEM-SHARED-007 — Escolha explícita Atual/Shaka

Estado: implementação local; evidência estática, sem validação audiovisual. Data: 16/10/2026.

Configurações → Player tem somente Atual (padrão) e Shaka. Preferência por navegador é independente da conta/cloud e capturada na próxima abertura; retries/fontes preservam o motor. Shaka5.2.13 vendorizado com integridade/licença carrega sob demanda, sem novo serviço. Adapter mantém controles/faixas/posição e restringe rede às rotas locais autenticadas. Encerramento assíncrono precede nova mídia; falha conserva barreira fechada. Uma conexão remota. Destruir Shaka elimina o buffer antigo: continuidade mostra último quadro capturável, sem promessa de vídeo contínuo/menos travamentos. Sem backend/Supabase/reinício.

Fontes: [contrato e versão](../../web/player/motores/README.md), `web/app.js`, `web/player/troca-canal/continuidade/`, `web/sistema/configuracoes/`. Revisão por quatro agentes, sintaxe e bundle em memória; sem testes, navegador ou mídia.

## MEM-SHARED-005 — Bootstrap pendente e recuperação da biblioteca

Estado: corrigido no código local; inspeção e sintaxe, sem testes ou UI. Data: 15/10/2026.

Uma resposta `cloud:null` não prova ausência de configuração: a preparação do backend pode continuar após o orçamento HTTP ou falhar temporariamente. A ponte da biblioteca aguarda/reconsulta `/api/session` sem revogar Auth já validado. Recuperação de sessão existente exige a mesma `libraryId`, projeto e usuário; logout explícito ou troca de conta continuam encerrando a sessão. Não buscar identidades por nome nem misturar bibliotecas entre aparelhos.

Reconexões da mesma conta preservam a fila em memória, inclusive quando armazenamento persistente está indisponível. Um bootstrap ausente não publica snapshot vazio. Hidratação aplica somente registros recebidos e remoções explícitas com data; favoritos locais de outra `libraryId` não são importados. O código sanitizado da falha do backend permanece separado do estado de configuração. Isto não comprova bootstrap remoto nem sincronização entre aparelhos no estado atual.

Fontes: `web/cloud-app-bridge.js`, `web/cloud-library.js`, `web/cloud-outbox.js`, `lib/cloud-attachment.mjs`, `lib/cloud-runtime.mjs`, `lib/account-library.mjs`, `lib/supabase-cloud.mjs`.

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
