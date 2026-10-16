# Carregamento da troca de canal

Implementação local de 16/10/2026. Este módulo acompanha somente uma escolha confirmada; percorrer a prévia com esquerda/direita não inicia preparação ou mídia.

Cima/baixo (inclusive ChannelUp/Down e PageUp/Down) e número usam a abertura e o visual superior padrão. Somente confirmar a prévia lateral com OK/Enter ou clique no canal do cabeçalho usa esta barra discreta. A origem da ação é encaminhada pela navegação até a aplicação; não é inferida pelo tempo de espera.

| Arquivo | Responsabilidade |
| --- | --- |
| `visualizacao.js` | Nome, número configurado, logo, programa/horários recebidos e barra indeterminada. `show`, `update`, `hide`, `destroy`. |
| `visualizacao.css` | Apresentação discreta no canto superior esquerdo, abaixo do fechar; adaptação móvel e movimento reduzido. |
| `servico.js` | Uma consulta abortável de descritores pelo serviço TV existente. Não abre vídeo nem faz prefetch dos vizinhos. |
| `orquestrador.js` | Intenção atual, escopo, cancelamento, preparação e entrega ao pipeline compartilhado. Não calcula programação ou progresso. |
| `continuidade/` | [Host, preparação de mídia, áudio e sequência de promoção](continuidade/README.md), com dois elementos locais e uma fonte remota. |

## Dados e fases

A aplicação injeta `{item, channelNumber, program}`. Nome/logo vêm do catálogo existente; número vem das preferências já configuradas; `program` é `TVGuide.peek(id).window.current`. O backend escolhe o programa e entrega `title`, `startLabel` e `endLabel`. A ausência de EPG mostra “Programação não informada”. O componente não consulta relógio, escolhe programa pelo horário, estima buffer ou calcula percentual, duração ou ETA.

`preparing` significa que a consulta autenticada `/api/live/sources` está pendente. Essa rota retorna somente descritores e não inicia outra transmissão: o canal atual continua durante essa fase. `connecting` prepara a mídia do alvo após confirmar STOP remoto, conservando o buffer local antigo enquanto disponível. `buffering` informa esgotamento desse buffer. A barra segue indeterminada e substitui o splash central nessa troca; a primeira abertura conserva a apresentação anterior.

A UI encerra no evento real `playing` do player correspondente, em falha/fechamento/cancelamento, ou quando a mídia está realmente pronta para play manual após bloqueio de autoplay. `loadeddata`/`canplay` e `readyState` são eventos/estados do elemento, não porcentagens calculadas. A mesma instância EPG pode atualizar a descrição durante a espera, sem consulta por canal.

## Propriedade e cancelamento

O controlador valida ID, conta/epoch, PIN, preferências de visibilidade e identidade do player antes de entregar a preparação. Uma nova intenção aborta a leitura anterior; segurar a mesma tecla não reinicia a mesma preparação. Erro ou prazo na consulta de descritores não chama STOP nem `playbackFailure` do canal antigo.

O resultado preparado é consumido uma vez, junto com o elemento/HLS/attempt correspondente. Ticket e descritores não são mantidos nas opções de retry/troca de fonte. Antes da promoção, cancelar destrói o standby e enfileira STOP da tentativa abandonada; depois dela, a mídia pertence aos guards de geração, request, conta e AbortController do player compartilhado. Conclusão/cancelamento remove a inscrição EPG e libera referências aos players antigos.

A continuidade agora usa dois elementos locais, com controles e áudio seguindo o ativo. A troca acontece com dados reais do alvo; se o buffer anterior acabar, conserva o último quadro disponível até a prontidão ou falha. O limite finito e o comportamento nativo estão documentados na [subpasta de continuidade](continuidade/README.md). Não existe mídia em Supabase, reprodução dos vizinhos ou promessa de troca instantânea. `transferMedia()` não é usado para mover buffers entre elementos.

Quatro agentes participaram de visual, integração/ciclo, contrato de fontes e revisão independente. Conferência limitada a revisão, sintaxe e compilação estática; sem testes, navegador, reprodução, chamadas remotas ou reinício. Nenhum endpoint/backend foi alterado. A ampliação de EPG de MEM-LIVE-014 continua aguardando o reinício autorizado separado.
