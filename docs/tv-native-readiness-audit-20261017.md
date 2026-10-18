# TV: confirmação de reprodução e medições de 17/10/2026

Estado: defeitos de interface reproduzidos e corrigidos localmente; transporte medido com decodificação real. Não certifica estabilidade do Safari nem prontidão para produção. A sessão de navegador do usuário não foi substituída nem o servidor reiniciado nesta rodada.

## Evidência e correção da interface

As capturas das 11:17 mostram preparação por 25–47 segundos, com buffer de 1,4/1,6 segundo e depois zero. Capturas anteriores registram `playing` com dimensões zero, erro sobre uma imagem e carregamento persistente. Uma imagem ou o nome de um evento não comprova reprodução contínua.

Foi reproduzida uma sequência específica usando os componentes reais: chega `playing` antes de existirem dimensões utilizáveis; a guarda o rejeita; depois chegam metadados e o relógio de mídia avança, mas não chega outro `playing`. O player permanecia com `started=false` e a sobreposição de carregamento. Outra reprodução mostrou que a confirmação posterior não concluía o ticket de troca de canal.

`web/tv/player/estado-media.js` agora observa a prontidão da TV e aceita também avanço do relógio com vídeo utilizável, sem seek. Troca de proprietário, elemento ou fonte e eventos de interrupção reiniciam a observação. O observador não chama play/pause/load/seek, não abre rede e não usa timer. PlayerTools, superfície imersiva e confirmação da aplicação usam esse caminho. Confirmar reprodução conclui o ticket da interface sem abortar a fonte ativa. Os caminhos de confirmação direta de adoção e o listener legado de troca permanecem restritos a VOD; TV aguarda a mesma confirmação observada.

Isso corrige um mecanismo demonstrado de carregamento incorreto e estado de troca pendente. Não demonstra que todas as pausas das capturas eram apenas visuais. Avanço do relógio também não certifica apresentação contínua de quadros.

O diagnóstico por abertura passou a incluir posição, pausa, seeking, estado de rede, visibilidade e contadores de quadros disponíveis. A API padrão informa quadros totais, que não são rotulados como quadros decodificados. Sem APIs válidas, registra `null`. Não adiciona timer, rede ou persistência.

## Reprodução real pelas rotas locais

Foi utilizado um diagnóstico temporário AVFoundation/AVPlayerItemVideoOutput no macOS, com um único vídeo por teste, pelas rotas HTTP reais do ARKHEN. Credenciais, cookie e endereço ficaram apenas na memória dos processos. O diagnóstico ficou limitado por prazo e enviou STOP da própria tentativa ao terminar; não executou logout remoto. Nenhum arquivo de credencial ou mídia foi gravado. Testes separados não constituem comparação simultânea controlada com o celular.

| Medida | Globo TV Sergipe | Record TV BA |
| --- | --- | --- |
| Duração da observação após anexar mídia | 60,015 s | 300,022 s |
| Preparação das fontes, antes de anexar mídia | 9.838 ms | 8.413 ms |
| Primeiro quadro amostrado após anexar mídia | 4,451 s | 3,070 s |
| Dimensões decodificadas | 1920×1080 | 1920×1080 |
| Quadros amostrados | 1.649 | 8.679 |
| Interrupções do access log nativo | 0 | 2 |
| Quadros descartados informados | 0 | 0 |
| Erros de mídia/item/player informados | 0 | 0 |
| Solicitações de mídia informadas | 31 | 112 |
| Bytes informados | 27.698.040 | 107.405.152 |

Na Record, as duas interrupções já constavam aos 25,484 s. O contador permaneceu em dois até o fim; a reprodução terminou em estado playing e buffer de 3,386 s. STOP concluiu com HTTP 200 em 594 ms. Na Globo, STOP concluiu com HTTP 200 em 624 ms. Posição avançada pode incluir o salto inicial para a borda ao vivo, portanto não foi usada como tempo efetivo assistido.

Os tempos de primeiro quadro excluem a preparação das fontes. Somar essas duas fases dá aproximadamente 14,3 s na Globo e 11,5 s na Record, além de etapas anteriores de login/catálogo. Logo, estas medições **não** comprovam abertura total em 3–4 segundos. Também não executam DOM, controles, fullscreen ou ciclo de vida do Safari.

Em duas janelas tardias da Record, a playlist tinha 20 segmentos/60 s, target duration 3 s; quatro segmentos entregaram 12 s de mídia em 608/510 ms agregados de transferência. Não houve falha, regressão de sequência ou mudança da URI local para segmentos idênticos nessas janelas. Esses recortes posteriores não explicam as duas interrupções iniciais. O observer mede segmentos concluídos: contagem zero não prova ausência de requisições.

## Preparação fria de metadados

Em uma sessão isolada, sem abrir mídia, a descoberta OTT levou 5.886,6 ms. Autenticação web consumiu 3.189,5 ms (resposta member seguida pelo fluxo legado existente), e catálogo 2.692,3 ms. A consulta seguinte na mesma sessão levou 1,8 ms, sem outra RPC. As três RPCs somaram 5.870,4 ms. Essas dependências explicam a maior parte da demora de descoberta medida; não explicam sozinhas os stalls posteriores.

Não foi removida autenticação nem mudado o servidor do provedor. Antecipar os metadados ao entrar em TV pode reduzir espera após o clique, mas exige respeitar foco de reprodução e propriedade do trabalho backend: cancelar hoje um leitor não cancela o trabalho compartilhado de catálogo. Essa antecipação não foi implementada nesta rodada.

## Validação e limites

Os testes de eventos exercitam os componentes e trechos reais da integração, incluindo evento precoce, avanço posterior, troca de proprietário/fonte, erro tardio e conclusão idempotente do ticket. Após a revisão dos caminhos de adoção, o conjunto direcionado de readiness, medição, qualidade, abertura, navegação e cloud passou com **88 testes**. A verificação específica de loader também passou na frente de revisão. Sintaxe dos módulos alterados e diff foram conferidos. A página temporária de diagnóstico foi removida.

Os arquivos frontend são servidos localmente com revalidação e ficam disponíveis após recarregar a aplicação. A correção separada de revalidação cloud permanece apenas no código até reiniciar o backend; os testes nativos usaram o processo já existente. Não foi reiniciado para evitar invalidar novamente as sessões em RAM durante a investigação.

O teste nativo separa decodificação/transporte da interface e demonstra que houve reprodução real. As duas pausas na Record impedem concluir que toda interrupção era causada pelos controles JavaScript. Causa dessas duas pausas, abertura total em até quatro segundos e funcionamento integral em Safari continuam pendentes. Nenhuma alteração de buffer ou tag HLS foi feita por suposição.

Fontes: capturas fornecidas pelo usuário; `web/tv/player/{estado-media,medicao}.js`; `web/player-tools.js`; `web/player/orquestrador.js`; `web/app.js`; `tests/tv-native-event-ownership.test.mjs`; `tests/tv-playback-measurement.test.mjs`; observações numéricas limitadas do diagnóstico local e `lib/tv/transport-observer.mjs`. A documentação de engenharia reversa existente é evidência estática; não há evidência nesta rodada de APK executado no Xcode.
