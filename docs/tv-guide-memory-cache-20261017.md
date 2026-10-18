# Cache de programação por canal no dispositivo

Data: 17/10/2026. Estado: código local e testes sintéticos. Não certifica reprodução, Safari, latência remota ou resolução dos erros 503 do catálogo.

## Navegação pronta no player — 18/10/2026

Estado desta correção: implementação local, inspeção e sintaxe; sem testes, navegador ou rede.

O cache anterior evitava consultas ao revisitar um canal, mas o player ainda assinava somente o ativo, a prévia e os dois vizinhos. Cada seta para um ID ainda não visitado ampliava esse conjunto e iniciava uma consulta tardia. Isso explicava “Carregando programação…” repetido na navegação, mesmo com o catálogo de TV já preparado.

A aceitação do catálogo live agora aquece uma projeção completa uma vez por escopo no cliente compartilhado, sem aguardar nem prolongar a entrada na aplicação. O aquecimento reutiliza mapa válido ou consulta em andamento; quando o voo anterior era parcial por IDs, mantém a demanda completa até o lote seguinte e remove esse consumidor depois. Em aba oculta, adia o aquecimento até a retomada. Conta/PIN/epoch, geração e abort continuam no `TVGuideClient`; não há persistência de biblioteca ou URLs de mídia. O protocolo completo já existente é `ids:null`, limitado à projeção validada de até 2.000 canais.

Mudança de conta, bootstrap ou PIN descarta a cobertura anterior e rearma uma antecipação no escopo novo, inclusive com catálogo já em RAM. Uma consulta completa que retorna degradada não é repetida imediatamente; o segundo lote é necessário somente ao compartilhar uma consulta anterior por IDs ou reconciliar publicação invalidada durante o voo. Uma nova captura EPG dentro do mesmo escopo vence os dados anteriores e passa a atualizar os IDs necessários, sem reaquecer automaticamente o catálogo inteiro a cada publicação.

Durante o player, a assinatura recorrente continua restrita ao ativo, à prévia e aos vizinhos. Enquanto as janelas antecipadas estão válidas, as setas usam RAM, sem nova consulta. Depois da validade, o último programa continua disponível como antigo e somente os IDs necessários são atualizados em lote; não se repete a projeção completa a cada minuto. Uma resposta parcial por IDs da mesma captura conserva a cobertura completa anterior até o prazo original, sem prolongá-lo. O canal ativo e a confirmação de sintonia mantêm seus contratos anteriores.

Canal legitimamente ausente de um mapa completo ou de uma seleção consultada recebe ausência conhecida, sem herdar o indicador de carregamento global. A ausência permanece disponível como antiga ao expirar. Um fallback parcial não apaga o mapa anterior nem certifica a ausência dos IDs omitidos; uma captura anterior por `snapshotFetchedAt` também não substitui a mais recente. A atualização respeita os prazos do servidor e as invalidações de publicação.

Essa antecipação corrige o carregamento tardio inicial por navegação; não mantém toda a grade eternamente atualizada nem garante disponibilidade de programação que o backend ainda não entregou. Falha real conserva o último mapa como antigo, sem inventar EPG. Fontes atuais: `web/app.js`, `web/tv/tanstack-query.js`, `web/tv/canais/cache-programacao.js` e `web/tv/player/grade.js`.

## Causas comprovadas no código

`TVGuideClient` já consultava a união de IDs necessários a cards, favoritos e player. Porém cada mudança da seleção invalidava a validade global, e cada resposta parcial substituía o mapa anterior. Navegar de três canais para outros três descartava janelas válidas do primeiro conjunto. Voltar ou reabrir a grade exigia nova consulta.

`FavoriteTVGuide` mantém a inscrição durante renderizações no mesmo escopo e seu `pause()` apenas remove o consumidor. Ele não limpava o cliente compartilhado. O descarte estava no armazenamento da projeção. No player, o DTO inicial vazio também podia mascarar a janela atualizada que chegava depois pelo guia compartilhado.

## Contrato adotado

`web/tv/canais/cache-programacao.js` guarda janelas selecionadas pelo servidor em RAM, por ID, dentro do escopo do cliente. Limite de 2.000 entradas, descarte LRU, sem persistir biblioteca ou fontes. A validade usa o intervalo já informado pelo servidor, respeitando os limites existentes; visitar o canal não prolonga esse prazo. A UI continua sem selecionar programas ou calcular progresso.

Uma resposta parcial atualiza somente os IDs pedidos/retornados. Canal solicitado e legitimamente ausente recebe uma entrada vazia com validade, evitando consultas repetidas. Publicação EPG nova ou mudança de conta/PIN/epoch limpa o cache; 401/403 também limpa. Falha transitória mantém dados conhecidos como antigos. Invalidação explícita vence as janelas sem apagar a apresentação.

Seleções cobertas por janelas válidas reutilizam RAM e mantêm uma única revalidação agendada. Uma seleção que muda enquanto uma consulta está em andamento reaproveita a resposta se ela já cobrir os novos IDs. Mudanças que exigem novos canais continuam formando a união num único pedido. Consumidores legados sem IDs mantêm a leitura completa e uma atualização parcial não certifica um mapa completo fresco.

A revisão independente encontrou e reproduziu uma corrida: invalidar a publicação durante uma consulta podia deixar a resposta anterior renovar o cache e adiar a consulta nova. Agora a geração de publicação é separada da mudança de seleção. Essa resposta continua disponível como antiga, com validade vencida, e a sequência exige uma consulta `fresh=1`. Duas invalidações e mudança de seleção durante o mesmo voo continuam coalescidas. Mera mudança de seleção pode aproveitar cobertura válida sem nova RPC.

O player dá prioridade à janela compartilhada para o canal ativo, inclusive quando ela informa legitimamente ausência de programação. Assim um DTO vazio da abertura não oculta o guia posterior e um programa antigo da abertura não reaparece sobre uma correção vazia.

O EPG selecionado do player permanece disponível durante vídeo; nenhuma retomada geral de catálogo, pré-carregamento de mídia ou consulta WPLAY por card foi introduzida. Os 503 de `catalog/revision` e `home/library` são incidentes separados e este cache não declara que foram corrigidos.

## Comparação com o APK

A [engenharia reversa estática](wplay/epg-apk-20261016.md) encontrou armazenamento `epg.data`, mapa em RAM e LRU no WPLAY. Isso apoia reutilização local, mas não comprova a cadência efetiva remota nem exige copiar a leitura integral para cada espectador. O ARKHEN mantém a projeção autorizada no servidor e cacheia somente as janelas já consultadas no dispositivo. Persistência em disco não foi adicionada.

## Verificação

33 testes passaram em `tv-guide-window-cache`, `program-guide`, `neighbor-program-feeds` e `immersive-channel-navigation`: revisita sem RPC, reabertura antes/depois da validade, seleção durante vídeo, resposta parcial, vazia, revisão, conta, cancelamento, LRU, seleção/invalidação em voo e prioridade da janela canônica. São verificações sintéticas sem mídia, rede remota, alteração SQL ou reinício.
