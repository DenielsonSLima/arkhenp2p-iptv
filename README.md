# ARKHEN P2 IPTV · Cinema e TV

Aplicativo local com catálogo real de TV ao vivo, filmes e séries, identidade própria e interface cinematográfica. O acesso padrão usa o contrato de autenticação e catálogo do APK WPLAY. Também aceita o player WPLAY OTT e servidores Xtream nas opções de conexão.

## Executar

Execute na raiz do projeto em Windows, macOS ou Linux:

```sh
npm start
```

Abra **http://localhost:4173** e mantenha o terminal aberto. No Windows, **`Iniciar ARKHEN.cmd`** executa esse comando; no macOS, use **`Iniciar ARKEHN.command`**. O fluxo padrão utiliza os serviços WPLAY e a reprodução HTTP do player web oficial. Use `Ctrl+C` para encerrar o servidor e limpar a reprodução.

O aplicativo requer Node.js 22 ou superior. O bundle do cliente Supabase/TanStack está versionado; para instalar as dependências fixadas e recompilá-lo, execute `npm ci` e `npm run build:cloud`. A integração experimental com o APK Android permanece opcional, documentada em [tools/original-engine/README.md](tools/original-engine/README.md).

Os avisos e licenças das dependências distribuídas estão em [CLOUD-LICENSES.txt](web/assets/vendor/CLOUD-LICENSES.txt), gerado junto com o bundle.

## Publicação e hospedagem

O repositório contém o código, os testes e os recursos da interface. Credenciais, sessões locais, APKs de investigação, emuladores, SDKs e ambientes de execução locais ficam fora do Git. A reprodução web usa as fontes autorizadas pela WPLAY; os experimentos com APK ficam documentados separadamente.

Para funcionar na Vercel, esta versão ainda precisa de adaptação do backend: o servidor aceita apenas acesso local e mantém sessões em memória. Publicar somente `web/` não disponibiliza as APIs necessárias para login, catálogo e reprodução. O envio ao GitHub preserva a versão local atual.

## Conexão

A conexão padrão conserva a autenticação, o catálogo e os identificadores WPLAY. Fontes HTTP do catálogo têm prioridade. Nos canais com fonte TVBus, a integração com `player.wplayott.com` consulta a transmissão web da mesma conta, com associação conservadora do canal. Favoritos e progresso conservam os identificadores originais.

A integração WPLAY usa os endpoints observados no APK; a opção WPLAY OTT usa o player web oficial. Cookies e tokens ficam na memória do servidor local. Usuário, senha, cookies, tokens e endereços privados do provedor não são incluídos nas respostas do catálogo nem nas URLs de reprodução apresentadas ao navegador.

O aplicativo abre uma tela de login com usuário e senha. **WPLAY** é o acesso padrão e usa o contrato do APK; **Opções de conexão** também oferece **WPLAY Web (alternativo)**, que usa OTT, e **Outro servidor IPTV**, que usa Xtream. O servidor salvo em `.local/connection.json` é usado apenas no modo Xtream quando o campo servidor fica vazio. Esse diretório não é servido ao navegador e está ignorado pelo Git. Uma nova sessão não autentica automaticamente com credenciais salvas. O navegador pode lembrar apenas o nome do usuário; a senha não é salva na interface.

No ícone de usuário, o menu **Sair da conta** encerra a reprodução e invalida o acesso ao catálogo e à mídia da sessão. As configurações ficam em uma página com navegação lateral para Configurações, Perfil, TV ao vivo, Vídeos, Séries, Reprodutor e Inicialização. Nesta última, é possível escolher a tela que aparece depois do login.

Para configurar um servidor Xtream, também aceita `IPTV_SERVER`, `IPTV_USERNAME` e `IPTV_PASSWORD` como variáveis de ambiente. O login pela interface continua exigindo usuário e senha.

## Funcionalidades

- A programação WPLAY é consultada pelo mesmo contrato do APK, associando o EPG ao canal ou à sua referência compartilhada. O servidor reutiliza a grade por cinco minutos; cards e player recalculam o programa atual a cada 15 segundos e consultam atualizações sem interromper o vídeo. Horários são exibidos no fuso local. Canais sem grade fornecida continuam identificados como programação não informada.
- TV ao vivo com categorias, busca, logos locais compactas e programação quando fornecida pelo serviço. O índice em `web/assets/channels/manifest.json` cruza nomes e IDs, preserva afiliadas e canais numerados e compartilha o mesmo arquivo entre variantes SD/HD/FHD. Logos ausentes usam a imagem do provedor como alternativa.
- Início com até seis destaques no banner (três filmes e três séries), trocados a cada cinco segundos, canais favoritos/recentes, últimos filmes assistidos, lançamentos de filmes, últimas séries assistidas e lançamentos de séries. Datas disponíveis determinam a ordem; o aplicativo não inventa ano ou duração ausentes. Cards com histórico exibem progresso e temporada/episódio atual.
- Filmes com capas, sinopse e página de prévia que ocupa a tela, com título, metadados e duração.
- Séries com prévia própria, contagem de temporadas e total de episódios, seleção de temporada, progresso por episódio e próximo episódio. Miniaturas usam a imagem fornecida pelo episódio ou, quando ausente, a imagem da série identificada como alternativa. A prévia da série não solicita duração do primeiro episódio como duração do título.
- Recomendações da home abaixo dos lançamentos de séries, calculadas por RPC com histórico privado, gêneros e avaliações. A prévia de filme, inclusive com Continuar assistindo, e a tela ao terminar usam sugestões do Supabase. Grupos genéricos como Lançamentos ou HD não contam como afinidade. O fim real do filme oferece até três opções, sem autoplay; falhas de consulta são explícitas. [Contrato, cache e estado de publicação](docs/home-and-movie-recommendations.md).
- Player em página de tela inteira, com tentativa de fullscreen nativo ao tocar em Assistir. Voltar restaura a prévia e a posição anterior do catálogo.
- Favoritos, posição de reprodução, listas e preferências separados por conta, com cache neste navegador e sincronização Supabase quando a nuvem está conectada. O login WPLAY validado provisiona a identidade da biblioteca; não há segunda senha. Registros antigos sem proprietário comprovado exigem importação explícita em Perfil. Referências temporárias de imagem são renovadas pela sessão atual.
- Reprodução HLS pelo Safari ou por HLS.js nos navegadores compatíveis.
- Proxy local para imagens, playlists HLS, segmentos, chaves e vídeos, incluindo requisições de intervalo para navegação no vídeo.
- Uma reprodução ativa por conexão; a anterior é encerrada ao trocar de conteúdo.
- Identidade em preto e prata, com símbolo e wordmark reconstruídos em SVG e PNG transparente de alta resolução, além do favicon.
- Configurações de reprodução, teste de conexão e organização do catálogo, com preferências da conta sincronizadas quando a nuvem está disponível.
- Configurações em página própria, com rota e navegação de volta ao catálogo.
- Categorias que podem ser ocultadas/restauradas. Filmes e Séries abrem em Favoritos quando há títulos salvos, ou em Lançamentos quando não há. A ordem é Favoritos, Lançamentos, Todos, demais categorias em ordem alfabética e Adulto ao final. A criação de categorias foi removida da interface.
- Resolução, áudio e legendas conforme as variantes e faixas disponibilizadas pela fonte; importação local de legendas SRT/WebVTT.
- Perfis de buffer separados para ao vivo e filmes/séries, quando HLS.js controla a reprodução; nas fontes nativas o navegador controla o buffer.
- Login com o mosaico enviado pelo usuário, degradê preto mais opaco à esquerda, símbolo em destaque e barra preta superior. A página ocupa a altura disponível; opções avançadas longas têm rolagem interna no formulário.
- Preparação com marca, progresso das etapas reais e pré-carregamento das primeiras capas antes de exibir o catálogo. Até 24 imagens, quatro por vez, com limite global de 8 segundos para essa etapa; falhas de imagem não impedem a entrada. Back/Forward aguarda a preparação terminar antes de iniciar mídia.
- Favoritos atualizados diretamente nos cards; categorias e carregamento adicional preservam imagens e controles já montados. Trocar a categoria retorna ao topo.
- Indicadores do player para vídeo disponível no buffer, resolução, travamentos observados e estimativa de entrega quando disponível.
- Qualidade automática que pode ser ativada/desativada e mantém a preferência neste navegador.
- Abertura e créditos usam somente marcadores conferidos para a edição do episódio ou marcações manuais nos ajustes do reprodutor. Referências comunitárias de APIs permanecem diagnósticas até essa confirmação. As contagens de abertura e próximo episódio duram cinco segundos e podem ser canceladas. Sem créditos conferidos, o padrão aguarda o evento real de fim do vídeo; preferências anteriores de intervalo final continuam respeitadas. Não há detecção automática de cenas; consulte [verificação dos marcadores](docs/marker-playback-verification.md).

O catálogo inclui as categorias disponibilizadas pela conta no provedor. Conteúdo adulto fica bloqueado por padrão, com PIN inicial `0000`; o desbloqueio exige também disponibilidade na assinatura. Sua reprodução não gera histórico, progresso ou Continuar assistindo, mesmo depois do desbloqueio. Categorias podem ser ocultadas em Configurações. A disponibilidade de cada mídia, qualidade e codecs depende do serviço e do navegador. Conteúdos MKV/AVI não são convertidos para outro formato pelo app.

Na conexão opcional WPLAY OTT, quando o player web informa que o servidor da lista está indisponível, o acesso retorna HTTP 503 com essa causa, sem classificar a falha como senha incorreta. Catálogos vazios recebidos durante essa condição não são guardados como atualização bem-sucedida. Essa falha do player web é independente do acesso WPLAY nativo, usado por padrão.

As logos locais foram obtidas do catálogo autorizado do APK WPLAY 11.9.0d: 202 arquivos WebP, aproximadamente 1,4 MB. O relatório da pasta registra as imagens indisponíveis; as origens, credenciais e tokens não são publicados. Para atualizar a pasta, use `node tools/sync-channel-logos.mjs` (player web) ou `node tools/sync-channel-logos.mjs --apk-native` (endpoint do APK documentado), fornecendo as credenciais somente na entrada temporária do terminal. O script baixa apenas logos, sem iniciar transmissões.

A duração dos filmes usa metadados com unidade explícita. Na prévia selecionada, quando ausente, o servidor pode ler o cabeçalho MP4 com requisições de intervalo limitadas a 8 consultas, 1 MB e 6 segundos. Não baixa o arquivo completo nem começa reprodução. A página aparece antes dessa consulta; iniciar o vídeo ou sair da prévia cancela a leitura. Séries exibem temporadas e episódios, usando durações individuais somente quando fornecidas para cada episódio. Fontes sem intervalos ou metadados válidos mostram duração indisponível; uma duração de filme observada na reprodução também pode aparecer ao revisitar a prévia.

O início da reprodução envia `play()` imediatamente após definir a fonte, prioriza HLS nativo quando disponível e elimina a consulta de sessão intermediária. Cookies e acesso continuam sendo conferidos pelo backend. O RPC de metadados aceita respostas comprimidas. A espera de encerramento do canal anterior continua serial, conforme o contrato do player oficial, para evitar fontes simultâneas durante a troca.

## Verificação

```sh
npm test
```

Os testes cobrem parser M3U, intervalos HTTP, isolamento dos arquivos, autenticação manual, privacidade das credenciais, categorias, temporadas, reprodução, reescrita HLS, origem das requisições, logout, diagnóstico, cancelamento de reprodução, cache de segmentos, scripts de inicialização, mudança de assinatura, decisões de qualidade automática, preservação dos cards e da sessão de transmissão, e segmentos truncados. Os testes usam um provedor local sintético, sem consumir conexões da assinatura.

Registro histórico da conexão WPLAY OTT em 13/10/2026: login real aprovado; 40 categorias de TV com 1.767 versões de canais, 25 categorias com 1.996 filmes e 30 categorias com 991 séries. Capas reais de filme, série e canal responderam HTTP 200; temporadas e episódios foram recebidos. O proxy entregou um trecho MP4/M4V real de filme, um trecho MP4 de episódio e uma playlist HLS com segmento de TV ao vivo. Essa verificação comprova acesso e entrega dessas amostras naquela sessão; não representa o total carregado pelo acesso nativo atual nem um teste prolongado de todos os títulos. As contagens abaixo registram a conexão Xtream anterior.

Verificação inicial com a conta real em 13/10/2026: autenticação ativa, 2.256 canais, 15.435 filmes (430 na categoria adulta) e 16.031 séries. Antes do ajuste de assinatura solicitado pelo usuário, a interface filtrava os filmes adultos e mostrava 15.005 filmes. Esse filtro fixo foi removido. Os catálogos carregaram em aproximadamente 1,7 a 2,9 segundos nesta sessão. TV Sergipe FHD reproduziu em tela cheia no Safari; detalhes de F1 e duas temporadas / 16 episódios de The Last of Us foram conferidos. A disponibilidade futura continua dependente do provedor.

Após a mudança de assinatura, a nova consulta real confirmou 2.339 canais (77 na categoria adulta), 15.435 filmes (430 na categoria adulta) e 16.031 séries, em cerca de 1,6–3,0 segundos. A atualização exibe progresso das três etapas e informa conclusão total, parcial ou erro.

O servidor atende exclusivamente em `127.0.0.1`. Para disponibilizar o produto fora deste computador, será necessária uma configuração própria de hospedagem e autenticação.

## Travamentos, atraso e pré-carregamento

O teste de conexão faz três consultas reais de metadados ao serviço. Latência e variação dessas consultas avaliam a API do catálogo, separadamente da mídia. A velocidade exibida vem dos segmentos HLS da reprodução atual, sem abrir um segundo canal. Antes de haver amostras suficientes, o teste informa que não consegue avaliar o vídeo. Ele não é um teste da velocidade total do plano de internet.

Na medição inicial de 13/10/2026, a API respondeu às três consultas, com mediana de aproximadamente 410 ms e variação de 13 ms. Essa medição não demonstra estabilidade prolongada da TV.

Para futebol, o perfil de menor atraso usa uma margem menor em relação à borda da transmissão. Ele não remove o atraso já introduzido pelo serviço. Para filmes, séries e novelas, o perfil mais estável permite carregar mais dados do título escolhido. As opções são alvos de carregamento, sujeitos ao formato da fonte e às decisões do navegador. Aumentar o buffer não cria uma resolução diferente nem transforma uma origem HLS comum em LL-HLS.

O servidor mantém em memória até 32 MB de segmentos já solicitados, com validade máxima de 60 segundos, sem baixar outro conteúdo em segundo plano. A identidade inclui URL, sequência e descontinuidade HLS para evitar reutilizar um segmento anterior quando a origem recicla a URL. Ao trocar ou encerrar a reprodução, esse cache é limpo. Esse reaproveitamento pode ajudar retentativas; não consegue antecipar um evento ao vivo que a origem ainda não transmitiu.

Se os segmentos chegam continuamente mais devagar do que o vídeo os consome, um buffer maior apenas adia o próximo travamento. Se chegam com folga mas há quadros perdidos, é preciso investigar codec, navegador e aparelho. Essas hipóteses precisam ser confirmadas pela telemetria da sessão.

Filmes, Séries e TV têm estados, erros e tarefas de importação independentes. O snapshot global completo é carregado integralmente e guardado no IndexedDB da TV/Chrome por 24 horas; reabrir dentro desse prazo reutiliza os metadados. Atualização ou erro preserva o último snapshot válido. Durante a primeira importação global, a prévia é identificada como incompleta; ela não representa o total do catálogo. A busca considera todos os metadados recebidos. Cards e imagens são montados conforme a navegação para reduzir trabalho visual, sem limitar a busca aos cards exibidos.

Favoritos, progresso e listas vêm da biblioteca privada, inclusive quando seus títulos estão fora da prévia. Realtime pessoal não dispara uma nova importação global a cada progresso. A arquitetura e os critérios de estabilização estão em [catálogos por domínio](docs/catalog-architecture.md) e no [plano de estabilização](docs/engineering-recovery.md). Ocultar grupos não altera o bitrate nem a capacidade do provedor.

### Qualidade automática

Quando uma playlist HLS oferece várias resoluções, HLS.js seleciona entre elas com base na estimativa de banda. Desativar a opção mantém o nível selecionado. Uma fonte única MP4/HLS não ganha resoluções novas por esse ajuste.

Em TV ao vivo com versões SD/HD/FHD/4K separadas do mesmo canal, o app pode reconectar a uma alternativa realmente presente no catálogo. A política desce um nível após duas interrupções observadas em 30 segundos e buffer abaixo de dois segundos. Só tenta subir após 90 segundos sem interrupções, pelo menos 15 segundos disponíveis e entrega medida de ao menos 2,5 vezes o bitrate observado da fonte atual. Há intervalo de 60 segundos entre tentativas e no máximo duas tentativas de subida por sessão. Esses valores são heurísticas conservadoras, não garantia de capacidade da fonte seguinte; rótulos HD/FHD vêm do provedor.

Trocar fontes separadas pode mudar o atraso e exige reconexão. A fonte anterior é encerrada antes de abrir a próxima, respeitando o plano de uma conexão. Não há troca entre canais regionais com nomes diferentes, nem entre filmes/episódios diferentes.

O HLS.js mantém retenção passada de 30 segundos para ao vivo e 60 segundos para VOD, com orçamento de buffer explícito. Esses limites são alvos suaves: a biblioteca pode precisar de mais memória para cumprir a duração configurada em fontes de bitrate alto. Após falhas de codec/mídia e recuperação limitada, o Safari pode tentar o player HLS nativo uma única vez. Também pode fazer essa tentativa após erros de carregamento esgotarem as recuperações, desde que a fonte já tenha entregado segmentos e resolução de vídeo. Isso não cria ciclos de troca. Os eventos conservam apenas tipo e código de erro reconhecidos, sem URLs nem dados de acesso.

O proxy reaproveita o endereço final resolvido da playlist durante a sessão. Quando esse endereço expira, tenta resolver novamente uma única vez. Isso evita repetir a entrada que pode criar novas sessões no provedor a cada atualização da playlist. Uma interrupção do corpo de um segmento é registrada como falha de entrega, separadamente de um cancelamento intencional do navegador.

### Reunião dos três agentes e pesquisa

Conclusão conjunta: medir a entrega, comparar um ajuste de cada vez, separar perfis de ao vivo e VOD e manter uma única fonte ativa. A discussão oficial [HLS.js #6237](https://github.com/video-dev/hls.js/discussions/6237) explica a influência da segmentação da origem no atraso. Relatos de TiviMate apresentam resultados diferentes para [buffer grande](https://www.reddit.com/r/TiviMate/comments/1nq50q3/buffering_on_tivimate_more_than_other_smarters/) e [buffer mínimo](https://www.reddit.com/r/TiviMate/comments/1wsz08v/buffering_on_tivimate_but_not_uhf/); são experiências anedóticas, não resultados de teste deste app.

### Firebase e Supabase

O Supabase do ARKHEN já está configurado para biblioteca por usuário, Realtime, metadados compartilhados e marcadores de episódios. A configuração aplicada, os módulos e os limites do worker estão em [Supabase do ARKHEN](docs/supabase-setup.md).

A conta de Firebase ou Supabase, sozinha, não muda o caminho do vídeo, que continua vindo do provedor. Essa é uma inferência da arquitetura documentada dos serviços. Eles podem armazenar favoritos, progresso, grupos, preferências e um catálogo paginado. O cache offline de dados facilita reabrir a interface, sem ser um buffer de vídeo.

Guardar mídia temporária em uma nuvem exigiria uma camada de ingestão/entrega, controle de acesso, expiração e tráfego próprios. Também acrescentaria uma etapa ao caminho da transmissão, que deve ser medida antes de concluir que melhora a experiência. A configuração atual do Supabase armazena dados da biblioteca e metadados; não armazena nem retransmite os vídeos.

Referências primárias: [buffer HLS.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md#maxbufferlength), [margem ao vivo HLS.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md#livesyncdurationcount), [MDN buffered](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered), [MDN preload](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload), [Firestore offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline), [Firebase Hosting cache](https://firebase.google.com/docs/hosting/manage-cache), [Supabase paginação](https://supabase.com/docs/reference/javascript/range), [Supabase Storage CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn).

### Comparação de servidores do painel

A pesquisa pública não encontrou um benchmark confiável que compare os servidores listados no painel Infinity. [Listas comerciais](https://revendaiptvmegga.com/) apresentam várias dessas marcas, sem medições padronizadas. Relatos encontrados para nomes homônimos em outros países não comprovam a identidade nem a qualidade das opções deste painel. Nenhuma assinatura foi migrada e nenhum acesso foi enviado a outro servidor.

Para futebol, comparar o mesmo jogo, qualidade semelhante, navegador e perfil de buffer, durante 20–30 minutos no horário de maior audiência. Registrar tempo até iniciar, quantidade e duração das interrupções, entrega dos segmentos, resolução real e atraso contra uma referência da transmissão. A distância até a borda HLS mede somente parte do atraso; ela não revela todo o tempo que a origem introduziu. Fazer uma comparação separada para filmes e séries, pois as prioridades são diferentes. O servidor atual permanece como referência até haver evidência suficiente de uma alternativa melhor.

## Estrutura

O [mapa de manutenção do player](docs/player-modules.md) relaciona os módulos de progresso por episódio, retomada, recuperação ao avançar, reprodução automática, logos, legendas, áudio e qualidade, com seus contratos e pontos de integração.

`web/` contém a interface e o player. O login fica em `login-screen.js` / `login-screen.css` e a preparação em `session-loader.js` / `session-loader.css`; o menu de conta em `account-menu.js`; as configurações em `settings-tools.js`, `settings-views.js` e `settings.css`; a preservação dos cards em `catalog-renderer.js`; as rotas em `page-routes.js`. Filmes ficam em `movie-preview.js` / `related-movies.js`, séries em `series-preview.js` e TV ao vivo em `live-view.js`; `preview-tools.js` compartilha capa, fatos e ações. `title-preview.css` e `playback-page.css` separam o visual das prévias e do player, importados pelo pequeno `immersive-pages.css`. A reprodução fica em `player-tools.js` e `immersive-player.js`. `lib/wplay-ott-provider.mjs` integra o player web WPLAY e `lib/ott-rpc.mjs` implementa a serialização RPC observada; `lib/media-duration.mjs` normaliza durações e `lib/mp4-duration.mjs` lê o cabeçalho de mídia selecionada; `lib/provider.mjs` integra Xtream; `lib/upstream.mjs` faz as conexões ao provedor; `lib/diagnostics.mjs` analisa as medições; `lib/app-server.mjs` atende arquivos e endpoints locais; `server.mjs` inicia o processo.

`lib/wplay-provider.mjs` implementa a autenticação e o catálogo WPLAY nativos, usados pelo login padrão; `lib/wplay-playback.mjs` encaminha filmes e episódios HTTP e integra os canais P2P à ponte local. `lib/original-engine-bridge.mjs` e `lib/native-bridge-manager.mjs` controlam a engine original e a posse da reprodução por sessão. WPLAY OTT continua sendo um conector alternativo explícito, documentado em `analysis/WPLAYOTT-browser-contract.md`.

Os arquivos `analysis/` e os APKs são evidências da investigação, sem execução pela interface. `analysis/WPLAYP2P-11.9.0d-findings.md`, `WPLAYP2P-11.9.0d-auth-contract.md` e `WPLAYP2P-11.9.0d-login-routing.md` registram a análise do APK 11.9.0d, incluindo endpoints, normalização do usuário com `@wareztv.io`, autenticação e engines nativas TVBus/BinStream. Os canais `tvbus://` são processados pela engine Android no emulador preparado; o navegador recebe HLS pelo proxy local. As bibliotecas Android ARM/JNI não executam diretamente no navegador.

HLS.js 1.6.13 é distribuído com sua licença em `web/assets/vendor/HLS-LICENSE.txt`.
