# TV ao vivo: abertura, qualidade e Home

Data: 17/10/2026 UTC (16/10 local). Quatro agentes: transporte/backend, qualidade/eventos, confronto com APK/web e revisão independente de associação. Código local ativado após testes; nenhuma migration nesta rodada. Sem navegador automatizado ou transmissão real iniciada pelo agente.

## Evidências anteriores à mudança

- O usuário corrigiu o relato para **8–12 segundos**, no motor Atual. Não são minutos e o número é observado pelo usuário, não uma medição nossa.
- Fixture de fonte HTTP nativa demonstrou que `liveSources()` fazia Auth e catálogo OTT dispensáveis; `playbackURL()` já evitava isso. A rota de fontes ainda aguardava bootstrap cloud, embora mídia não dependesse dele.
- `openPlayer` aguardava STOP e depois os descritores. Erros de descoberta podiam seguir para `/api/play`, repetindo uma resolução falha. O teste novo prova que metadados podem ser obtidos durante a parada, mas mídia só é liberada após ambos terminarem.
- A política anterior descia após dois travamentos e liberava ABR silencioso. O resolvedor web ainda preferia HD, mesmo com variantes superiores disponíveis. Ambos foram reproduzidos com fixtures antes da alteração.
- 404 e 409 correspondem respectivamente a associação ausente e ambígua entre catálogos. Favoritos preservam o ID nativo; não conferem equivalência com IDs opacos OTT. A imagem não prova falha de resolução do decoder. Foi reproduzida a diferença de nomes e duplicidade de identidade; a associação real dos canais reclamados ainda precisa de evidência.
- Home: o leitor podia continuar esperando a atualização do catálogo completo após o prazo de 6 s do frontend. O catálogo já tinha coalescência/TTL; a correção não foi criar polling. Fixture com refresh pendente e cancelamento comprovou o bloqueio. Isso explica um mecanismo possível do aviso, sem atribuir a ocorrência real sem medição.

## Contrato final

### Abertura

`lib/tv/orquestrador.mjs` valida conta, expiração, prova de autenticação, PIN, geração e abort sem aguardar Supabase para listar fontes. `lib/wplay/conexao/reproducao.mjs` só descobre OTT automaticamente se faltar HTTP nativo válido; `all=1` mantém descoberta completa explícita. Não transforma TVBus/TVCarS em URLs HTTP.

`web/tv/player/abertura.js` obtém descritores enquanto o decoder/provedor anterior encerra. STOP permanece obrigatório antes de anexar mídia. Falha de STOP aborta o leitor; uma falha de fonte não é repetida pela rota de mídia. Engine, conta e intenção continuam protegidas contra respostas tardias.

`Server-Timing` separa `provider` e `sources` na consulta de fontes, e `prepare` e `upstream` na mídia. Os dados são somente durações, sem credenciais/endereço. O intervalo OTT de 3 s entre gerações permanece; não é atraso fixo da primeira abertura.

### Qualidade

Abertura automática escolhe a maior resolução **declarada e disponível** entre as fontes já associadas com segurança, ou o maior nível HLS compatível. `sourceId` explícito continua sendo respeitado. Dimensões decodificadas não são inferidas dos nomes HD/4K.

`web/tv/player/qualidade-adaptativa.js` possui a política e o aviso dentro da superfície fullscreen. Quatro episódios distintos de `waiting` após `playing`, em 30 s, abrem aviso de 5 s no canto superior direito. Startup, pausa, seeking e eventos repetidos durante a mesma espera não contam. “Manter qualidade” cancela e exige quatro novos episódios. Pausa, documento oculto, fechamento, conta/fonte/seleção manual e falhas de autorização/STOP cancelam a decisão.

Após a contagem, desce um nível real compatível sem recriar decoder. Guarda altura/bitrate/codec contra reordenação do manifesto. Ao esgotar um manifesto com vários níveis não retorna a uma qualidade nominal superior; um manifesto único limita as alternativas à altura oferecida. Codec diferente requer capacidade confirmada. Redução automática aceita somente níveis do manifesto ou descritores do mesmo ID de canal; variantes de outro ID são escolha manual. Recuperação fatal pode trocar por fonte da mesma qualidade, no orçamento de duas tentativas, sem revisitar; não baixa silenciosamente. 401/403/409/429 continuam bloqueados. O helper adaptativo legado permanece exportado, mas não controla mais as reduções do player.

No Safari nativo, a aplicação seleciona descritores oferecidos; o navegador pode controlar internamente variantes de um master sem API pública de nível. A política de aviso controla as trocas da aplicação, não uma capacidade inexistente do player nativo. Filmes e Séries conservam políticas próprias.

### Associação

`resolver-web.mjs` continua exigindo campo de origem explicitamente compartilhado ou nome completo conservador e único. Não usa EPG como identidade de mídia, não inventa aliases nem interpreta números de hashes. Duplicatas da mesma identidade são seguras; IDs distintos de mesmo nome não são fundidos por preferência de resolução.

`[arkhen.live.mapping]` registra somente nome/ID nativo público, contagem e até oito exemplos de nomes/qualidades. Não enumera IDs OTT, URLs, headers ou credenciais. Limite de uma emissão por canal/código a cada 30 s e 64 chaves por instância. Exemplos por palavras em comum são apenas diagnósticos, nunca candidatos aceitos automaticamente.

### Home

Pedido posterior removeu a prévia. `HomeChannelShelf` não cria vídeo, não carrega engine e não abre fonte. Todos os cinco cards usam logo; o primeiro destaque tem moldura branca. Exibe apenas programa atual, horários e progresso já calculados pelo servidor. Cinco colunas no desktop, três até 1050 px, duas até 650 px e uma até 340 px. Clique continua solicitando fullscreen no gesto autorizado.

A superfície fullscreen temporária agora tem propriedade compartilhada: duas aberturas concorrentes que falham antes de criar player encerram a superfície uma única vez. O bug e a correção foram reproduzidos executando `openPlayer` extraído do código em fixture.

`CloudRuntime.catalogForProjection` retém apenas referência a snapshot completo, não vazio, validado por publicação e por no máximo 24 h/expiração da publicação. Reutiliza IDs durante revalidação compartilhada; não renova TTL do catálogo no navegador. A RPC revalida geração atual, conta, disponibilidade, classificação e filtros. Abort encerra só o leitor. O aviso de falha com cards disponíveis fica compacto; não é ocultado como se a atualização tivesse funcionado.

## Validação e limites

138 testes internos passaram na verificação final (128 de transporte, qualidade, Home, cloud e regressões; mais 10 de lifecycle/fullscreen). Incluem servidores HTTP sintéticos em loopback, sem usar sessão pessoal ou mídia do provedor. Sintaxe, bundle do app com vendor externo e `git diff --check` passaram. Uma fixture antiga de grade recebeu o método `metadata.start` que o módulo atual já exige.

Servidor local reiniciado para ativar os módulos backend. Não certifica transmissão, aparência ou abertura real em 3–4 s. Foi solicitado ao usuário repetir os dois canais depois de recarregar; os resultados e durações reais continuam pendentes. Não houve deploy remoto, alteração Supabase, novo login real nem leitura de browser.

## Confronto com a documentação

[WPLAY web observado](wplay/reproducao.md) e [APK](engenharia-reversa-wplay-20261016/05-reproducao-e-memoria.md) separam evidência estática de comportamento efetivo. O web observado usa margem de quatro segmentos, igual ao perfil equilibrado local, e inicia próximo de 720p. O APK contém defaults Media3 de startup/rebuffer, mas a configuração efetiva está protegida. Esses dados não justificam reduzir buffers cegamente nem prometer a mesma latência.

Fontes primárias consultadas: [HLS.js 1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/docs/API.md), [Media3 DefaultLoadControl](https://developer.android.com/reference/androidx/media3/exoplayer/DefaultLoadControl). Maior qualidade inicial é uma decisão do usuário para ARKHEN, não uma alegação sobre o APK.

## Reabertura da investigação em 17/10 local

O usuário confirmou comparação na mesma rede, motor Atual, startup de 8–12 s e travamentos somente no ARKHEN. Novas capturas mostram aviso de quatro esperas seguido de mudança do canal central, além de timeout de descoberta e uma abertura com 11 s. As imagens não mostram o evento de entrada que iniciou a mudança de canal; não certificam que o callback de redução tenha escolhido o outro canal. A confirmação audiovisual de estabilidade continua pendente.

Quatro agentes trabalharam em transporte, frontend, comparação APK/web e medição; a continuidade solicitada utilizou três frentes. Antes dos patches, fixtures demonstraram:

- Restaurar preferências iguais de TV podia desfazer uma redução aprovada ou buscar a posição live sem gesto do usuário. A restauração ficou idempotente na TV; perfil remoto diferente aplica orçamento sem seek. Ação explícita e VOD conservam seu contrato.
- A contagem antiga podia disputar uma intenção manual ainda preparando o próximo canal. Navegação pendente cancela/bloqueia a redução e a decisão final revalida a propriedade. A redução não abre outro ID, mesmo com nome de família idêntico.
- Shift+número armava sintonia numérica; modificadores e interação no aviso agora não acionam atalhos globais. Isso corrige um caminho reproduzido, sem atribuir as capturas a uma tecla que não foi observada.
- Reescrever segmentos byte-range com URI opaca por sequência invalidava offsets implícitos. O helper TV materializa offsets válidos antes da reescrita, preservando precisão uint64 e quebrando a cadeia em outro recurso/segmento integral/entrada inválida. Filmes e Séries não passam por essa normalização. Conforme [RFC 8216 §4.2 e §4.3.2.2](https://www.rfc-editor.org/rfc/rfc8216). Não se observou se a fonte real usa byte ranges.

O proxy entregou primeiro chunk em 12 ms contra 10 ms direto, em uma fixture local de 2 MiB, e manteve uma conexão em 20 ranges sucessivos. Isso descarta retenção integral e falta geral de keep-alive nesse teste, não mede Internet ou vídeo decodificado. Redirects encerram a conexão de origem; como não há prova de redirects por segmento real, esse comportamento não foi alterado. Safari Atual usa HLS nativo e não executa os ajustes de buffer HLS.js; WebAudio é desativado nessa plataforma. Alterar esses buffers não trataria a ocorrência demonstrada pelas imagens.

### Medição passiva

`lib/tv/transport-observer.mjs` observa somente requests que já existem: preparação, manifesto, segmento e cache; separa headers, primeiro corpo e duração. Há limite de 36 eventos por cliente/5 min, agregação de 10 s e propriedade por intenção. Sem URLs, IDs de canal, conta, headers, tokens, probes, timers ou persistência. O log local é `[tv-transport]`; tempo total de segmento inclui backpressure do navegador.

`web/tv/player/medicao.js` registra por abertura fontes, barreira STOP, início da mídia, primeiro `playing`, interrupções, buffer e dimensões, com até seis eventos `[arkhen.tv.playback]`. Preparação anterior e espera por play manual são identificadas. Resource Timing já existente é resumido sem URLs; tempo anterior à requisição inclui agendamento/conexão, não prova fila. Safari pode não expor essas amostras. Não cria requisição, timer ou armazenamento. `playing` não mede o primeiro quadro efetivamente exibido.

O diagnóstico de conexão antigo continua manual e faz três sondas de metadados; não foi usado para medir nem acionado automaticamente. Os erros transitórios de Home/capas tiveram `CLOUD_TIMEOUT` nos logs locais e o usuário confirmou recuperação; nenhuma alteração Supabase foi feita nesta rodada.

### Evidência real posterior e correção de propriedade dos eventos

Capturas de 17/10 entre 00:17 e 00:21 demonstraram falha inicial de descoberta, reprodução posterior e novas interrupções. Uma abertura nativa 1920×1080 registrou fontes3453ms, barreiraSTOP15ms, antes da mídia3497ms e mídia até playing5191ms, total8688ms; buffer inicial1,3s e depois0s. Em outra abertura, `playing` foi registrado com dimensões0×0 e readyState1. Esse último evento não comprova vídeo pronto. O erro terminal sobre uma imagem anterior também não comprova recuperação: parar novos segmentos pode deixar o buffer/imagem na tela.

O proxy observou, na primeira abertura, preparação4,8ms, primeiro manifesto3345ms e primeiro segmento344ms/1s de mídia. Janelas seguintes entregaram9s de segmentos em aproximadamente1,2–1,4s de transferência agregada, sem falhaHTTP registrada nessas janelas. Não há ResourceTiming nativo disponível nas capturas. Esses números não certificam continuidade, nem explicam sozinhos a interrupção.

Fixtures RED/GREEN confirmaram: eventos `playing` sem vídeo pronto armavam a contagem/ocultavam o carregamento; `error` nativo já limpo por `load()` desmontava uma fonte nova; callback HLS depois de falha terminal podia reabrir o mesmo owner. TV agora valida estado/dimensões antes de aceitar `playing`, ignora o erro sem `MediaError` atual e encerra callbacks de recuperação de owners terminais. O evento `failed` inclui somente enum de tipo/detalhe HLS reconhecido e statusHTTP, sem mensagem bruta/URL. Não foi introduzido watchdog ou retry ilimitado.

A [descoberta de fontes](tv-source-discovery-20261017.md) eliminou autenticação repetida com sessão válida e preserva um único trabalho de metadados entre leitores cancelados. O limiteUI de4s foi alinhado ao orçamento40s da descoberta, mantendo cancelamento imediato; isso evita rejeição precoce, não promete startup em3–4s. Import e prazo do app foram integrados.

Por pedido explícito, iniciar TV/Filme/Série pausa trabalho de catálogo, paginação, Home, busca e sugestões invisíveis, incluindo atualizações diárias e retries de capas ocultas. Preserva snapshots/caches/cooldown/hints para retomar ao fechar. Auth, progresso, STOP, áudio, legendas e EPG do player não dependem dessa guarda.

Verificação integrada desta rodada:85testes de frontend/descoberta/foco e63de transporte/HTTP/regressão passaram; bundleESM e diffcheck passaram. Quatro falhas legadas de `shared-catalog-updates.test.mjs` foram reproduzidas sem a mudança de pausa e permanecem fora deste conjunto, sem alterar expectativas para escondê-las. Servidor local foi reiniciado com este conjunto; solicitado novo teste real ao usuário. As capturas anteriores não validam o código posterior e a estabilidade segue pendente. Sem navegador automatizado, segundo stream, alteração Supabase ou deploy.
