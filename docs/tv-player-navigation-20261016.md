# Player TV: módulos, navegação e análise de carregamento

Data: 16/10/2026. Estado: implementação local da UI e análise estática do transporte. Sem navegador, testes, reprodução, operação remota ou reinício do servidor; a sessão existente foi preservada.

Etapa posterior na mesma data: [troca-canal](../web/player/troca-canal/README.md) implementa a barra indeterminada e a preparação de descritores antes do handoff. Substitui somente as pendências dessas duas partes descritas abaixo; continuidade do vídeo antigo até o primeiro quadro e prebuffer de vizinhos permanecem não implementados.

## Auditoria e fronteiras

Quatro agentes distintos analisaram modularidade, transporte/buffer, teclado/estado e revisão independente. Antes desta extração, `web/immersive-player.js` continha 376 linhas, reunindo montagem, volume, pausa, teclado, números, vizinhos e EPG. Serviços, fontes, áudio e buffer TV já tinham implementações próprias. `web/player-tools.js` ainda concentra menus, apresentação de métricas e recuperação; `web/app.js` continua dono da abertura/parada, geração, AbortController e único pipeline de mídia. Não foi atribuída uma segunda propriedade desses estados à UI.

A implementação visual canônica agora está em `web/player/`, com controles separados de reprodução/volume, helpers DOM, teclado e orquestração. `web/immersive-player.js` preserva os exports antigos como fachada. O cabeçalho, seleção de canais, numeração e inscrição EPG pertencem a `web/tv/player/`; serviços permanecem em `web/tv/services.js`. A [tabela de módulos](../web/player/README.md) identifica cada responsável. As políticas de Filmes e os controladores de Séries não foram reorganizados nesta etapa.

## Contrato de navegação implementado

| Ação | Comportamento |
| --- | --- |
| Cima/baixo, ChannelUp/Down, PageUp/Down | Confirma imediatamente o vizinho do canal ativo. |
| Esquerda/direita em TV | Move somente a prévia superior e seus vizinhos; o vídeo e o rodapé continuam representando o canal ativo. |
| Enter/OK/Select/Accept na superfície ou na grade | Confirma a prévia existente. |
| Clique/toque em um canal do cabeçalho | Confirma aquele canal. |
| Quatro segundos sem nova navegação lateral | Cancela a prévia, volta a seleção ao ativo e oculta a grade superior. Nunca sintoniza por timeout. |
| Dígitos | Cancela a prévia; preserva a numeração configurada, com confirmação após um segundo ou Enter. Navegação por setas cancela os dígitos pendentes. |
| Campo de volume/seek, menus, ajustes e outros diálogos | Conserva o teclado do controle. Enter em pausa, favoritos ou ajustes não confirma outro canal. |

A prévia guarda um ID independente de `current`. Somente confirmação explícita ou troca vertical chama o callback de reprodução. Alterar o guia não chama `/api/play`, não envia STOP e não muda `src`. A inscrição usa o mapa `TVGuideClient` existente; não cria consulta por vizinho. Eventos EPG não inventam horários nem atualizam a identidade do canal ativo. Ao remover um favorito ou reatribuir seu número, o ID real da reprodução prevalece sobre o número antigo. Fechar/trocar título ou conta cancela o timer; callbacks atrasados não restauram a prévia.

## Ideias de redução de espera

**Manter cinco segundos de cada vizinho:** não foi implementado. Com o canal atual, seriam três fluxos de mídia. No contrato atual, `reservePlaybackIntent` cria uma nova geração e invalida a anterior. `WplayPlaybackProviderClient.playbackURL` e `TransporteWebTv.start` cancelam a seleção anterior e param o transporte. No caminho OTT há um `sid` de tela, confirmação STOP 204 e espaçamento mínimo de três segundos entre gerações. Ausência de limite informado pela conta não comprova suporte a reprodução simultânea. Um buffer de cinco segundos também não garante cobrir autenticação, STOP, manifesto e decodificação.

**Preparar informações antes de parar o vídeo atual:** é viável como etapa futura delimitada. `tv.preparePlayback()` lê apenas os descritores de `TVServices.liveSources`, com cache por escopo de 30 segundos. Pode adiantar catálogo e seleção de fontes sem abrir mídia. EPG e logos já são metadados independentes. Nesta etapa não se acrescentou coleta especulativa de fontes: a mudança implementada é a navegação/UI.

**Manter o vídeo antigo em movimento até o primeiro quadro do alvo:** exige outra etapa de arquitetura. Hoje `stopPlayback()` destrói HLS e limpa o vídeo antes de preparar o alvo. Uma alternativa a investigar, conservando uma transmissão remota, seria interromper downloads antigos, preservar seu buffer local, confirmar STOP e carregar o alvo em um segundo pipeline local. A troca visual/áudio ocorreria apenas no primeiro quadro pronto. O vídeo antigo só continuaria enquanto seu buffer durasse; seriam necessários cancelamento por intenção, fallback, áudio único e tratamento próprio de HLS nativo. Nenhuma fluidez instantânea foi demonstrada.

Supabase continua responsável pelos metadados existentes, não por armazenar/transmitir os segmentos privados de cada conta. Uma barra discreta deve refletir etapas reais ou atividade indeterminada; não pode representar cinco segundos de vídeo carregados quando apenas descritores foram obtidos. A barra de troca e a continuidade do vídeo antigo **não foram implementadas** neste lote.

## Fontes e verificação

Fontes locais: `web/player/`, `web/tv/player/`, `web/app.js` (`openPlayer`/`stopPlayback`), `web/tv/services.js`, `web/tv/buffer.js`, `lib/live-playback-session.mjs`, `lib/wplay-playback.mjs`, `lib/tv/transporte-web.mjs`, `lib/wplay-ott-provider.mjs` e [contrato WPLAY](wplay-playback-contract.md).

A revisão é por leitura, sintaxe e compilação estática, sem prova funcional ou audiovisual. As alterações desta UI são arquivos estáticos e não exigem reiniciar o Node; não se fez recarga do navegador pela automação. A ampliação do EPG registrada em MEM-LIVE-014 continua pendente de reinício autorizado do backend, conforme a decisão de manter a sessão aberta.
