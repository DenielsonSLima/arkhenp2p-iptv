# Reprodução oficial e integração ARKHEN

Revisão estática: 16/10/2026. Fontes e offsets em [Evidências](evidencias.md). Nenhuma transmissão foi iniciada para produzir este documento.

## Motor web observado

O componente `ot` de `watch-D81zhcTq.js` usa um elemento de vídeo e importa dinamicamente `hls-BhcDaTqf.js`. O asset HLS declara versão 1.7.3. O ramo ao vivo testa suporte nativo HLS e identifica Safari/iOS, incluindo iPad com plataforma MacIntel e múltiplos pontos de toque. Nesse caso escolhe vídeo nativo; nos demais usa HLS.js, com alternativa nativa quando o suporte MSE não está disponível.

VOD primeiro atribui a fonte ao vídeo nativo. Um erro antes de qualquer dado de mídia permite tentar HLS.js. TV e VOD compartilham o componente, mas possuem políticas diferentes. A busca estática nesses dois assets não encontrou Shaka; isso não afirma ausência em todo recurso remoto ou em futuras versões.

**Comparação local:** `web/player/motores/orquestrador.js` oferece o motor `current` com HLS.js/HLS nativo e uma opção Shaka do ARKHEN. O ramo Shaka é uma escolha local, não o motor demonstrado pelo bundle oficial inspecionado. Não é evidência para instalar Android nem converter protocolos.

## Sessão de TV, STOP e geração

1. A tela live conserva um identificador de sessão e contador de geração no `sessionStorage`.
2. Uma fila serializa a seleção. O contador de intenção invalida seleções substituídas antes e depois dos awaits.
3. Havendo fonte anterior, a nova seleção aguarda sua parada. STOP é POST no endereço autorizado com os parâmetros `stop`, `sid` e `gen`; exige HTTP 204 e tem prazo de 12 s. Uma falha impede confirmar a nova seleção.
4. O início seguinte aguarda apenas o restante de um intervalo de 3 s entre gerações. A primeira abertura não recebe um atraso fixo artificial.
5. O manifesto de TV usa a sessão/geração capturadas. `pagehide` também envia uma parada por beacon como melhor esforço, diferente da confirmação exigida durante uma troca normal.

`lib/wplay/ott/provedor.mjs` conserva esse contrato em `livePlaybackURL` e `queueRemoteStop`. `lib/wplay/ao-vivo/transporte-web.mjs` mantém fila e cancelamento por sessão, preparação web e propriedade dos endereços autorizados. Uma resposta tardia não deve reviver a fonte substituída; STOP antigo não deve atingir uma geração nova.

## HTTP 429 e interrupção

O loader live oficial permite uma recuperação após 429 quando já houve `playing`, a seleção não terminou e o pedido corresponde a nível, faixa de áudio ou fragmento. A espera usa Retry-After numérico ou data, com mínimo 30 s e máximo 35 s para essa recuperação. Acima desse máximo a recuperação automática é recusada. O orçamento é compartilhado pelo loader e só admite uma recuperação nessa instância; abort/destroy cancelam os temporizadores e a fila.

Se 429 chega ao tratamento terminal de erro do player live, ele interrompe carregamento, pausa, solicita STOP e mostra ação de tentar novamente. O clique aguarda STOP antes de uma nova geração. Portanto, a evidência não sustenta repetir indefinidamente manifesto/login/troca de qualidade após 429.

Para VOD, o ramo de erro fatal tem recuperação limitada e conserva a posição. A política específica de recuperação única live não se aplica automaticamente a arquivos de filme/episódio.

## Buffer e qualidade

O perfil live observado desativa baixa latência, usa quatro segmentos de margem e limita reprodução acelerada a 1. O cache anunciado é 36 s/54 s, com 6 s anteriores e limite de 32 MiB. O componente aplica inicialmente um nível HLS próximo de 720 linhas. Esses números descrevem a configuração desta versão pública; não provam latência real, bitrate ou capacidade de qualquer canal.

O ARKHEN pode possuir perfis solicitados pelo usuário, mas precisa registrá-los como decisões próprias. Não atribuir ao APK uma política de iniciar na maior resolução sem prova. HLS.js ou Shaka não criam variantes que não existem no manifesto.

## APK e ausência de conversão automática

O APK contém TVCore/TVBus e BinStream/TVCarS em bibliotecas JNI Android ARM, além de componentes de mídia Android. A saída HLS local descrita nas bibliotecas é produzida após preparação pela engine Android; não é uma fórmula para converter `tvbus://` ou `tvcars://` em um endereço remoto.

O inventário do APK não identificou arquivos JS/HTML/WASM redistribuíveis como uma engine web. Métodos nativos/protegidos limitam a reconstrução estática de algumas decisões. Essa diferença sustenta usar o contrato HTTP do site oficial no produto web; não sustenta criar uma ponte local experimental como requisito de reprodução.

## Fronteiras de falha

Biblioteca Supabase, guia EPG, preparação OTT, manifesto, segmentos e decodificação são fases diferentes. Um bootstrap cloud com timeout não demonstra falha de mídia; um503 de play também não prova que a recomendação ou EPG causou a interrupção. Diagnósticos precisam informar fase/código/status/tempo, sem expor fonte, conta ou headers.

**Lacunas:** esta leitura não prova autenticação atual, STOP efetivamente aceito, CDN acessível, codec decodificado ou vídeo exibido no ARKHEN. Os comportamentos acima foram lidos em código estático; reprodução real e avaliação visual continuam com o usuário.
