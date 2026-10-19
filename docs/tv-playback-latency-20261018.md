# TV: latência de playlists e checkpoint de sessão

Data: 18/10/2026, horário local. Estado: ajustes locais e verificação sintética; publicação e reprodução real posteriores precisam de evidência própria. Esta revisão utiliza o contrato web, sem APK, autenticação, navegador ou abertura de mídia na frente que produziu este relatório.

## Evidência e separação das fases

As capturas do incidente das 19:55–19:57 mostram carregamento prolongado, buffer pequeno e ausência de dimensões decodificadas. Na investigação coordenada, foram relatadas respostas de produção na faixa de 3–7 segundos. Esse intervalo é evidência operacional sanitizada da rodada, não uma distribuição estatística nem uma medição atribuída exclusivamente ao servidor WPLAY.

Há fases diferentes entre o comando de assistir e os primeiros quadros: descoberta da fonte, STOP anterior, aquisição/restauração da sessão, checkpoint, resposta upstream, reescrita/liberação da sessão e decodificação. Um atraso total não identifica sozinho a fase responsável. Uma janela HLS pequena ou que não avança também não demonstra, isoladamente, falha do provedor, cache, decoder ou interface.

A tela “Buscando” pode permanecer antes de qualquer mídia ser anexada: `prepareTVOpening` aguarda descritores e barreira STOP, com orçamento de descoberta de 40 segundos. “Carregando” e buffer de 1,4 segundo não comprovam vídeo decodificado. A confirmação de TV exige vídeo utilizável, dimensões positivas e `playing` válido ou avanço observado do relógio, sem seek. O botão “Pausar” apenas reflete `paused=false`.

Fontes locais: `web/app.js`, `web/tv/player/abertura.js`, `web/tv/player/estado-media.js` e [auditoria anterior de prontidão](tv-native-readiness-audit-20261017.md). As observações anteriores não certificam o incidente atual.

## Prazo de playlist no HLS.js

A política local anterior de Media Playlist tinha 4 segundos para primeiro byte e 8 segundos totais. Uma resposta válida cujos headers chegam em 7 segundos era abortada aos 4 segundos, iniciando uma tentativa adicional antes que o primeiro pedido pudesse terminar. Isso foi reproduzido com o loader XHR real do HLS.js vendorizado e relógio virtual, sem rede.

O ajuste em `web/tv/buffer.js` altera somente a política de playlists da TV:

| Recurso | Primeiro byte | Pedido completo | Tentativas adicionais |
| --- | ---: | ---: | --- |
| Playlist TV, antes | 4 s | 8 s | 1 |
| Playlist TV, depois | 10 s | 15 s | 1 |
| Manifesto inicial TV | 55 s | 60 s | 0 |
| Segmento TV | 6 s | 15 s | 1 |
| Playlist VOD | 4 s | 8 s | sem alteração |

A política continua configurando uma tentativa adicional para timeout ou erro, com atraso de 500 ms limitado a 1.000 ms. No pipeline completo do HLS.js, Media Playlists usam o ErrorController/BasePlaylistController para decidir e agendar o retry; o PlaylistLoader desativa o retry interno do loader nesses pedidos. Os 15 segundos incluem a espera pelos headers; receber headers não cria outros 15 segundos de orçamento. A recuperação da aplicação continua com seu orçamento próprio. Essa configuração não limita o número de respostas HTTP200 válidas que repetem uma playlist sem avanço. Ver [revisão do pipeline completo](tv-hls-upstream-pipeline-review-20261018.md).

O HLS.js 1.6.13 define `maxTimeToFirstByteMs` e `maxLoadTimeMs` separadamente; seu default de playlist é 10/20 segundos. A escolha local de 10/15 segundos concede margem ao intervalo observado e mantém um total inferior a esse default. Não altera seleção de fonte, qualidade, margem live, tamanho de buffer, posição inicial ou política de segmentos. [Documentação primária HLS.js 1.6.13](https://raw.githubusercontent.com/video-dev/hls.js/v1.6.13/docs/API.md).

## Contrato web oficial reconferido

GETs exclusivamente públicos de HTML/JavaScript confirmaram, nesta rodada, os mesmos assets registrados em [Evidências WPLAY](wplay/evidencias.md):

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `index-DVOFCX81.js` | 546195 | `300404ba356c356b4991b15c47513db49e97c40512b3dfd72e0c8aeb5a8b2200` |
| `watch-D81zhcTq.js` | 91180 | `9834816cc51b361721ad7435885aace8c6153ea7d70e6e735701cf03f6d0673e` |
| `hls-BhcDaTqf.js` | 574790 | `5b33b12b2af3235f18d377a5b3d673d6baeb95b85a02a2c8d5cb3514c1bcf2ff` |

No watch, o SRC live é o `playbackUrl` do catálogo acrescido de `sid` e `gen`; o trecho não adiciona tipo, proxy ou cachebuster. O intervalo de 3 segundos no componente de mídia observa relógio/quadros, sem HTTP. A fila de seleção também conserva um intervalo mínimo de 3 segundos entre gerações; isso não constitui heartbeat. Não foram encontrados HEAD, `xhrSetup`, `fetchSetup` ou headers personalizados no ramo de reprodução inspecionado. A ausência é delimitada a esse código estático, não a todos os recursos ou ao tráfego real do site.

O perfil oficial live inspecionado usa quatro segmentos de margem, `lowLatencyMode=false`, prazo legado de nível de 10 segundos e HLS.js 1.7.3. O ajuste ARKHEN é uma decisão local para o seu caminho HTTP; não afirma equivalência completa com a política oficial. O site oficial começa próximo de 720 linhas, enquanto a preferência de qualidade do ARKHEN mantém seu contrato próprio.

Análise REA do watch atual: `ev_e496ac1bf3deb3a533626920c31092b5d035f387d2388cb4394f6c2f5a3c5023`. Um arquivo JS analisado, zero falhas de parsing; relações semânticas permanecem parciais. Complemento por inspeção textual dos bytes: SRC em torno do offset 11.625, configuração HLS em 14.000 e observador de 3 segundos em 16.925. Os offsets são aproximações de localização, não provas de execução. Fonte pública: [watch distribuído](https://player.wplayott.com/assets/watch-D81zhcTq.js).

## Checkpoint sem mudança e medição do runtime

O patch coordenado em `RuntimeSessionStore` compara o digest do snapshot capturado com o checkpoint já comprometido. Quando `checkpoint(false)` não mudou o conteúdo, evita uma RPC de commit redundante antes do upstream. Continua drenando trabalho pendente, serializando/calculando o digest, verificando validade do lease e aguardando renovação em voo. Não transforma a operação em leitura sem autorização.

Uma fonte alterada continua exigindo checkpoint durável antes de iniciar I/O de mídia. A liberação do writer continua executando commit, mesmo sem novo cipher, para registrar liberação e epoch. Fence, revisão, expiração, renovação e revogação de leitores preservam seus contratos. Portanto, “no-op” significa evitar esse commit intermediário específico; aquisição, restauração, serialização, liberação e eventuais validações continuam tendo custo.

O `Server-Timing` novo separa durações/contagens fixas de `runtime_acquire`, `runtime_wait`, `runtime_read`, `runtime_restore`, `runtime_serialize`, `runtime_codec`, `runtime_commit` e `runtime_validate`. `runtime_wait` mede separadamente os intervalos entre respostas BUSY. Headers e primeiro byte do corpo usam a mesma origem temporal de rede. A medida `upstream` passa a começar imediatamente antes da chamada de rede, depois do checkpoint, para não atribuir esse custo local ao provedor. As medidas podem descrever etapas contidas em outras fases e não devem ser somadas cegamente. Não contêm URLs, conta, cookie, token ou conteúdo do checkpoint.

Fontes: `lib/runtime-session-store.mjs`, `lib/app-server.mjs` e os novos casos de `tests/runtime-session-store.test.mjs`. A inspeção deste relatório confirma a lógica/cobertura implementada; a rodada integrada aprovou 147 testes únicos de runtime, transporte, STOP, seleção, prontidão, PIN e loaders. Os seis testes HTTP de loopback exigiram execução fora do sandbox de rede; depois passaram. Bundles backend/frontend e diff também foram conferidos.

## Verificação e limites

Foram executados 32 testes focados de frontend: `tv-playlist-load-policy`, `hls-error-handler`, `tv-native-event-ownership` e `playback-loader`. Todos passaram após o ajuste. O caso de headers em 7 segundos falhou antes e passou depois. Outros casos exercitam falta de headers, corpo incompleto respeitando o prazo total, destruição durante espera e cancelamento de retry. São loaders/eventos reais com dependências sintéticas, sem mídia ou rede. O teste direto do XHR não instancia o pipeline completo PlaylistLoader/LevelController/ErrorController e não certifica a recuperação integrada da engine. Sintaxe de `web/tv/buffer.js` e `git diff --check` passaram.

Um mock antigo do loader precisou fornecer `updateLiveMetadata`, exigido pelo listener atual do rodapé. A correção ficou no teste; não mudou o comportamento de reprodução para acomodar a fixture.

Safari nativo não executa `playlistLoadPolicy` do HLS.js. A alteração não certifica nem corrige, por si, o travamento nativo mostrado nas capturas. Não foi acrescentado watchdog, seek para live edge, tag `EXT-X-START` ou declaração artificial de segmentos independentes. A reescrita atual conserva tags/timestamps do manifesto e não cria keyframes. Playlist que permanece sem avanço, ausência de quadros e headers efetivos do navegador ainda precisam de evidência específica antes de atribuir causa ou alterar esse caminho.

Este documento não certifica deploy, reprodução no Safari, continuidade audiovisual ou abertura em um prazo prometido.
