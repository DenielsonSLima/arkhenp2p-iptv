# Descoberta de fontes TV antes da mídia

Data: 17/10/2026. Estado: correções locais e testes sintéticos; consultas autenticadas de metadados descritas abaixo. Sem validação audiovisual no Safari nesta rodada.

## Evidências

O usuário observou erro de busca da fonte antes de a mídia iniciar. Uma leitura real posterior informou `sourcesMs=3453`, `beforeMediaMs=3497` e `mediaToPlayingMs=5191`: descoberta e espera do navegador são fases diferentes. Esses números não demonstram a origem de todos os travamentos.

Fixtures reproduziram os mecanismos locais antes das correções:

- `/api/live/sources` chamava `connect()` mesmo com sessão WPLAY ativa e prova válida. No inventário, `item()` chegava a `catalog()`, que renovava login após cinco minutos antes de consultar um catálogo já em RAM.
- Cancelar um leitor OTT abortava a leitura do catálogo e removia seu memo. Duas tentativas produziram duas leituras canceladas.
- Logout com mídia ativa podia aguardar um STOP enfileirado atrás da descoberta antes de chamar `close()`; o encerramento da conta não abortava a descoberta prontamente.
- A UI interrompia descoberta legítima aos quatro segundos, embora a preparação de metadados OTT tivesse orçamento de quarenta segundos. O caso sintético de cinco segundos falhava antes da mudança.

## Contrato implementado

`lib/tv/orquestrador.mjs` reaproveita a sessão WPLAY existente na rota de fontes, mantendo status, expiração, prova de até 24 horas, PIN, geração e cancelamento. Outros provedores preservam seu caminho anterior.

`inventario-fontes.mjs` usa `readWplayLiveCatalog` com o token já autorizado. Conserva a validade de quinze minutos do catálogo nativo e a coalescência por cliente. A leitura de fontes mantém o limite existente de bytes/timeout do JSON nativo, sem herdar o corte de dois mil canais da publicação EPG. O EPG mantém seu padrão de dois mil. Cancelar um leitor não torna inválida a publicação de metadados para outro leitor da mesma conta; trocar sessão/autorização continua impedindo o retorno e a publicação atrasados.

`WplayWebPlayback` admite um único trabalho de autenticação e catálogo de fontes por instância privada, com prazo próprio máximo de quarenta segundos. O leitor cancelado termina; outro leitor pode aguardar esse mesmo trabalho. A conclusão nunca inicia mídia. `close()` aborta o trabalho, e o logout fecha essa autorização antes de aguardar a fila de STOP. Nenhuma credencial, URL ou fonte passa a ser cache global.

`TV_SOURCE_DISCOVERY_TIMEOUT_MS` centraliza quarenta segundos para os consumidores de preparação. `ChannelSwitchService` já usa a constante; o import e a substituição do timeout em `web/app.js` são integrados separadamente pelo principal. Isso remove um erro artificial precoce, sem prometer descoberta rápida nem ocultar o tempo mostrado na tela. Uma nova intenção do usuário continua cancelando imediatamente.

## Verificação e limites

Dezesseis testes de descoberta, inventário e abertura passaram. Vinte e duas regressões de HTTP sintético verificaram STOP, sid/gen, contas distintas, PIN, logout e descarte de respostas antigas. São conjuntos diferentes. Os testes não usaram mídia ou credenciais do provedor; o loopback foi exclusivamente sintético.

Fontes: `lib/tv/orquestrador.mjs`, `lib/wplay/ao-vivo/{inventario-fontes,catalogo-autorizado,transporte-web}.mjs`, `lib/wplay/conexao/reproducao.mjs`, `web/tv/player/abertura.js`, `web/player/troca-canal/servico.js`, `tests/{wplay-source-discovery,wplay-live-preparation,app-server-live-sources,tv-opening,wplay-web-playback}.test.mjs`.

O prazo OTT começa no trabalho de metadados correspondente; filas do navegador e a leitura inicial do catálogo nativo são fases adicionais. A configuração de quarenta segundos não certifica um limite total de ponta a ponta. A fase de mídia nativa e os travamentos após `playing` exigem evidência própria e continuam separados desta correção.

## Captura posterior do usuário, 17/10 às13:45

O evento informativo `first-playing` mostrou `sourcesMs=8814`, `beforeMediaMs=8851`, `mediaToPlayingMs=2609`, `startupMs=11460`, `stopBarrierMs=5`, vídeo1280×720 e buffer2,87s. `stalls=0` e `waitingMs=0` descrevem somente o período até esse evento, sem certificar continuidade posterior. A maior parcela observada da abertura foi a fase de descoberta/preparação da fonte; o registro agregado não separa autenticação OTT, catálogo, fila e transporte dessa fase.

`TVPlaybackMeasurement` usa `console.info`, sem transporte de rede, timers ou controle de mídia. `prepared:false` corresponde à ausência de `preparedLiveSources`/`preparedVideo` ao abrir, e não a erro de prontidão. Campos de Resource Timing nulos com zero amostras significam que não houve medição utilizável nesse agregado. Não ocultar esses limites nem interpretar contadores de frames ausentes/zerados como prova de falta de vídeo.

## Medição autenticada e autorização da fonte, 17/10/2026

Autorização expressa do usuário para acessar/testar Safari e conta WPLAY. O controle remoto continuou retornando `Sky Computer Use native pipe startup failed`; não houve inspeção audiovisual. Probes usaram login normal, sessão própria em RAM, somente metadados e logout dessa sessão. Não abriram manifesto/segmento nem executaram stop sobre a sessão do usuário.

Na instância principal anterior à alteração desta seção, duas consultas de fontes responderam HTTP200 em **5142ms** e **3ms**. `Server-Timing` da primeira: validação634,5ms e fontes4502,5ms. Na segunda: validação0ms e fontes1,8ms. Portanto, esse teste confirmou reutilização de cache; não reproduziu invalidação contínua.

Um probe separado instrumentou apenas as fases dos métodos privados: autenticação nativa622ms; catálogo nativo616ms; login OTT702ms; login legado352ms; catálogo OTT1987ms. A descoberta fria totalizou3681ms, seguida de2ms com cache. São amostras diferentes, não parcelas do evento de8814ms do screenshot nem prova da causa dos travamentos.

Foi encontrada uma dependência residual no caminho de `/api/live/sources`: `ParentalControl.authorize()` consultava `parentalCatalogItem` na nuvem antes do catálogo necessário à própria descoberta. Quando caía no catálogo genérico, este podia chamar `connect()` e renovar autenticação após cinco minutos. O caminho agora fornece `loadCatalog` exclusivamente para a TV WPLAY nativa. `liveSourceCatalog()` lê o catálogo da conta com autorização existente e a mesma validade de15min usada pelo inventário. A classificação parental e as fontes reutilizam essa leitura. Outros consumidores de `authorize()` preservam o fluxo anterior.

O leitor verifica proprietário, autorização e geração também ao concluir uma promise já em cache. PIN, canais inexistentes, fontes HTTP nativas, qualidade explícita e STOP/sid/gen permanecem verificados. A alteração não antecipa login OTT, não aumenta TTL e não persiste credenciais/fontes no navegador ou no Supabase.

**39 testes sintéticos passaram**: `wplay-live-preparation`, `wplay-source-discovery`, `wplay-live-source-isolation`, `app-server-live-sources`, `app-server-parental` e `wplay-web-playback`. A primeira execução dos testes HTTP falhou no sandbox por `listen EPERM`; a execução autorizada em loopback concluiu os39. Diff sem erros de whitespace.

Na instância temporária4174 com a alteração: login200/1659ms; fontes200/**5982ms** (validação1023,3ms, fontes4954,6ms), repetição200/**2ms**, logout200/105ms. O aumento observado entre amostras impede afirmar redução do tempo total. O benefício comprovado pelo contrato/testes é retirar a consulta cloud e a renovação genérica da autorização de fontes; a abertura fria web continua variável e lenta. A instância temporária foi encerrada. Ativação da principal e eventual nova medição devem ser registradas separadamente.

**Ativação conferida:** servidor principal4173 encerrado normalmente e iniciado com o código atualizado. Esse reinício encerrou as sessões em RAM, conforme informado ao usuário. Probe próprio após ativação: login200/1458ms; fontes200/**5546ms** (validação733,1ms, fontes4808,8ms); repetição200/**5ms** (fontes2,3ms); logout200/92ms. As duas leituras retornaram seis descritores, três disponíveis. Não houve abertura de mídia pelo probe. A latência de descoberta fria permanece pendente; nenhum desses tempos certifica primeiro quadro ou ausência de travamentos no Safari.
