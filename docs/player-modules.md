# Mapa de manutenção do player

`web/app.js` coordena a sessão, a fonte de vídeo e os módulos abaixo. Cada módulo tem um único responsável por seu estado; os controles de séries não iniciam uma segunda transmissão em paralelo.

| Recurso | Implementação | Integração e regras |
| --- | --- | --- |
| Progresso de cada episódio | `web/episode-progress.js`, `web/series-preview.js`, `web/episode-progress.css` | `saveProgress()` salva o episódio atual antes da troca. A prévia recebe `readEpisodeProgress`. [Contrato](episode-progress.md). |
| Miniaturas dos episódios | `web/series-preview.js`, `web/title-preview.css` | Imagem fornecida pelo episódio; fallback da série identificado e carregamento lazy. |
| Referências de abertura/créditos | `web/series-markers/index.js`, `web/series-markers/reader.js` | Banco autorizado com fallback local; identidade, duração, cancelamento e marcações comunitárias em teste. |
| Favoritos e histórico da conta | `web/media-library.js`, `web/settings-views.js` | Chaves v3 por `libraryId`; dados antigos sem conta exigem importação deliberada no Perfil. [Contrato](media-library.md). |
| Sincronização da biblioteca | `web/cloud-library.js`, `web/cloud-app-bridge.js`, `web/cloud-outbox.js` | TanStack Query, Realtime e fila offline por conta; favoritos, progresso, preferências e coleções. [Contrato](cloud-library-client.md). |
| Atualizações do catálogo compartilhado | `web/shared-catalog-updates.js`, `web/app.js` | Eventos Realtime agrupados leem novamente os snapshots via Node, sem solicitar nova coleta ao provedor. Substituem o catálogo para refletir inclusões e remoções, preservando a reprodução atual. |
| Escolha da posição de retomada | `web/playback-position.js` | Prefere o episódio exato; rejeita o histórico identificado como pertencente a outra conta. O guard impede que metadados ainda incompletos sobrescrevam a posição salva com zero. |
| Avançar/retroceder e recuperar travamento | `web/vod-seek.js` | Slider, teclado, abertura e recomeço usam `onSeek`. Espera metadados, preserva pausa e admite uma recarga por operação travada. [Contrato](vod-seek.md). |
| Começar do início | `web/resume-prompt.js`, `web/resume-prompt.css` | Oferta por cinco segundos após a retomada realmente reproduzir. Foco de teclado preserva o botão até sair dele. Reset cancela timers antigos. |
| Abertura, créditos e próximo episódio | `web/episode-skip.js`, `web/episode-skip.css` | Único responsável pelo avanço automático. Tem contagem cancelável de cinco segundos. [Contrato e limites](series-playback.md). |
| Configurações de séries | `web/series-playback-preferences.js`, `web/series-playback-preferences-view.js` | Uma instância compartilhada por Configurações e player. Rota `#settings/series-playback`. |
| Controles e navegação entre canais | `web/immersive-player.js`, `web/neighbor-program-feeds.js` | Canal atual em destaque, vizinhos menores; programação real por canal. |
| Intro durante o carregamento | `web/playback-loader.js`, `web/playback-loader.css` | Marca animada, etapas reais da fonte e buffer; sai no evento `playing`, com fade visual de 350 ms, sem atrasar o vídeo. Bloqueio de autoplay libera o play manual; interrupções usam uma apresentação compacta. |
| Logos no cabeçalho do player | `web/player-channel-logos.js`, `web/player-channel-logos.css` | Usa apenas arte local/registrada. Falha da imagem preserva nome e número. |
| Superfície sem moldura de foco | `web/player-surface.css` | Carregar por último. Remove o contorno da área de vídeo e preserva o foco dos controles. [Motivo](player-surface.md). |
| Qualidade automática e fontes equivalentes | `web/player-tools.js`, `web/adaptive-quality.js`, `web/channel-variants.js` | ABR do manifesto quando houver níveis; fontes separadas exigem troca controlada. 4K nominal e dimensões decodificadas são informações diferentes. |
| Falhas do serviço P2P local | `web/playback-api-error.js`, `web/app.js` | Reconhece códigos conhecidos no JSON da resposta HLS já recebida; apresenta mensagem fixa e encerra aquela instância HLS, sem repetir erro terminal ou refletir mensagens/URLs do provedor. |
| Áudio | `web/audio-processing.js`, `web/audio-preferences.js`, `web/channel-volume-memory.js` | Compressor optativo nos navegadores compatíveis; Safari preserva o caminho original. Memória por canal guarda ajustes manuais. Não é medição LUFS. |
| Legendas | `web/subtitle-layout.js`, `web/player.css` | Centraliza cues de texto e dimensiona a fonte. Texto gravado na própria imagem não pode ser reposicionado. |

## Ciclo de reprodução

1. `openPlayer()` encerra a fonte anterior e salva seu progresso enquanto a identidade antiga ainda está disponível.
2. A nova identidade invalida callbacks, contagens e operações de seek antigos. O carregador mantém uma única fonte ativa.
3. A retomada seleciona o registro do episódio exato. O player só aplica o salto quando há metadados suficientes e não grava zero enquanto essa retomada está pendente.
4. Um seek travado pode recarregar a mesma fonte e o mesmo alvo uma vez. Uma nova ação explícita do usuário recebe um novo limite de recuperação.
5. O avanço automático informa sua causa para registrar a conclusão antes de abrir o próximo episódio. O botão manual de próximo episódio não marca como concluído um episódio abandonado no meio.

## Intro de reprodução

Ao abrir um título, a preparação mostra a marca ARKHEN, o nome e, nas séries, temporada/episódio. A barra representa três etapas, sem porcentagem de download: seleção/busca da fonte, identificação e carregamento dos primeiros quadros. A solicitação da fonte, seus metadados e os eventos HLS atualizam as etapas; tempo decorrido não inventa progresso. `loadeddata` mantém a intro enquanto o vídeo ainda não reproduz. `playing` inicia a saída visual, sem duração mínima obrigatória e sem iniciar outra fonte.

As amostras de fragmentos HLS e de requisições nativas concluídas, quando expostas por Resource Timing, mostram **Recebendo vídeo**. Respostas nativas em cache e amostras anteriores à fonte atual são descartadas; a taxa expira após dez segundos. Na ausência de amostra, `navigator.connection.downlink`, quando disponível, aparece como **Conexão estimada**, com origem explícita no navegador. Sem ambos os dados, a interface aguarda a rede, sem inventar uma velocidade. Não há teste de velocidade extra nem medição do plano de internet. **Vídeo disponível** informa somente os segundos em buffer na posição atual.

Erro, fechamento ou troca de título cancela a espera anterior. Após o primeiro início, buffering usa uma apresentação compacta, sem repetir a entrada cinematográfica. A preferência por movimento reduzido desliga animações e fade.

## Conta e reinício do servidor

`lib/account-library.mjs` acrescenta `account.libraryId` às respostas autenticadas de login/sessão. É um hash estável do provedor, servidor e usuário; não inclui a senha. Progresso por episódio e marcações novas usam esse identificador para persistir por conta. Se o backend ainda não fornece o campo, o progresso novo funciona na memória da sessão. O histórico legado por provedor não é importado cegamente para o novo armazenamento.

Com Supabase configurado, o backend provisiona ou reaproveita a identidade somente após validar a conta WPLAY. O cliente sincroniza a biblioteca e as preferências dessa identidade. Metadados globais e marcações são atualizados por Edge Functions agendadas pelo banco; o catálogo exige uma fonte HTTP autenticada ainda válida. O navegador conserva snapshots completos em IndexedDB por 24 horas. A reprodução individual permanece no backend local: se o provedor disponibiliza HTTP, essa fonte é preferida; canais exclusivamente TVBus exigem a ponte P2P compatível. Armazenar o catálogo no Supabase não substitui esse serviço. Os limites da verificação estão em [configuração do Supabase](supabase-setup.md).

Alterações em `web/` são servidas pelo processo local existente e entram ao atualizar a página. Alterações em `lib/` exigem reiniciar o Node; as sessões do servidor atual ficam na memória, portanto um reinício pode exigir novo login. A agenda em `lib/wplay-games.mjs` também depende desse reinício e de o provedor disponibilizar o serviço de jogos para a conta.

## Validação

Execute `npm test`. Os testes de transporte usam provedores HTTP sintéticos locais, sem ocupar uma conexão da assinatura. Os módulos têm testes próprios para timers, pausa, cancelamento, troca de conta/fonte e posição de retomada. Isso não substitui conferir o seek e a renderização na versão real do Safari/dispositivo.

A intro foi conferida no Chrome em 1440 × 960, 390 × 844 e 844 × 390, incluindo a passagem para um clipe WebM sintético, espera compacta, erro e fechamento, sem erros JavaScript. Os 71 testes dos módulos de player selecionados passaram. A suíte completa no Windows teve 655 verificações aprovadas, duas falhas (caminho POSIX fixo em `p2p-runtime.test.mjs` e permissão de symlink em `static-paths.test.mjs`) e quatro cancelamentos por uma promessa pendente em `original-engine-bridge.test.mjs`. Esses arquivos e a ponte Android não foram alterados pela intro.

Em 15/10/2026, `.local/verify-daily-catalog-cache.mjs` verificou o aplicativo e IndexedDB reais em contexto Chrome isolado, com API sintética: 120 canais, 180 filmes e 180 séries, uma chamada completa por tipo na primeira abertura, zero na recarga dentro do dia, busca pelos últimos itens, uma atualização por tipo após 24 horas e conservação do snapshot antigo/idade após HTTP 503. Outra conta reutilizou somente os metadados globais e manteve favoritos próprios separados; outra partição recebeu snapshots independentes. O teste encontrou e corrigiu a renovação indevida de `savedAt` após falha offline.

`.local/verify-live-error-browser.mjs` verificou a interface com HLS real e falha de serviço sintética. A mensagem específica apareceu em 340 ms, com tentativa manual disponível e nenhum retry depois do erro terminal. Esse Chrome tentou HLS nativo uma vez antes do fallback HLS.js existente; foram duas solicitações iniciais, e somente uma delas pertenceu ao HLS.js. Isso comprova a apresentação do erro, sem comprovar uma transmissão WPLAY ou uma ponte local operacional.
