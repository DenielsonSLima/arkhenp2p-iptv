# Continuidade local entre canais

Implementação de 16/10/2026, conferida estaticamente. Participação de quatro agentes auxiliares em host, preparação, áudio e revisão do contrato. Não houve reprodução ou comprovação audiovisual.

Dois elementos locais, no máximo, compartilham uma única reprodução remota. Somente a confirmação da prévia lateral entra neste fluxo. Cima/baixo e entrada por número continuam usando a abertura padrão.

| Arquivo | Responsabilidade |
| --- | --- |
| `host.js` | Elemento visível, standby reutilizável, fachada dos controles, migração de listeners e último quadro como fallback. |
| `host.css` | Sobreposição dos dois elementos; standby sem interação e sem ocultação que impeça decodificação. |
| `preparacao.js` | Transporte do alvo silenciado, prontidão real da mídia, prazo, cancelamento e adoção sem recarregar a fonte. |
| `audio.js` | Um `AudioProcessing` por elemento real, preferências compartilhadas e encaminhamento ao áudio ativo. |
| `fluxo.js` | Sequência STOP → preparar alvo → promover; identidade da intenção, escopo e limpeza. |

## Sequência

1. `ChannelSwitchController` prepara os descritores pelo serviço TV existente; nessa fase o atual ainda recebe mídia.
2. `LiveContinuityFlow` resolve o motor escolhido antes de suspender o atual. Depois, interrompe os downloads antigos, suspende sua recuperação e aguarda o encerramento local do transporte e o STOP remoto na fila da aplicação. HLS.js conserva apenas o que já recebeu; motores que descarregam a mídia usam o quadro capturado antes da parada.
3. `PreparedLiveVideo` abre a rota local autenticada do alvo no segundo elemento, silenciado. Não recebe URLs privadas do provedor nem abre os vizinhos.
4. `requestVideoFrameCallback`, quando disponível, confirma um quadro. Navegadores que não apresentam callbacks para um vídeo oculto usam a presença real de dados atuais, dimensões e ausência de erro, após uma espera curta. Descritor ou fragmento baixado não libera a troca.
5. A aplicação adota o mesmo elemento/HLS/attempt pronto e migra controles, eventos e áudio. Não abre novamente a fonte. O slot anterior é limpo e fica disponível para outra troca.

O grafo WebAudio continua pertencendo ao seu elemento real. HLS também recebe o elemento real; a fachada estável fica nos controles. PlayerTools e legendas são reinicializados antes da promoção e reanexados ao elemento escolhido.

## Limites e cancelamento

O buffer antigo é finito. Ao esgotar, mostra-se o último quadro disponível e a espera discreta; a captura pode ser indisponível por restrição do navegador ou da mídia. Não há loop de trecho antigo, garantia de troca instantânea ou cinco segundos prometidos. O caminho nativo não oferece o mesmo controle de downloads do HLS; STOP invalida a tentativa no backend e a continuidade local é de melhor esforço.

Erro nativo de formato/decodificação admite uma recuperação para HLS no mesmo URL/attempt/fonte. Antes dela, a consulta autenticada de status precisa confirmar ausência de falha remota. Resposta ambígua, recusa, limite, erro de autenticação ou cancelamento impede o fallback; o elemento nativo é desanexado antes de começar HLS.

Uma nova intenção aborta o standby. Se já houve abertura remota do alvo, sua limpeza entra na mesma fila de STOP antes da próxima fonte. Callbacks antigos não podem recuperar o canal aposentado. Após adoção, cancelamento da barra não destrói a mídia que já pertence ao player ativo. Fechar, trocar normalmente, alterar escopo ou falhar limpa a operação correspondente.

## Injeção do transporte escolhido

Há somente duas escolhas explícitas: `current` e `shaka`. Não há modo automático nem tentativa paralela de motores. `getTransport(item, {signal, video})` resolve `{HlsClass, usingNativeHLS, engine}` de forma assíncrona, podendo carregar código, sem abrir manifesto ou mídia. Identidade do ticket, conta e player são conferidos novamente após essa espera. Motor ausente ou incompatível falha antes de interromper o canal atual. Sem callback, continua a escolha nativa/HLS.js existente.

O adaptador compatível pode retornar uma Promise de `stopLoad()` e expor `whenStopped`. Ambos precisam terminar antes de STOP e de qualquer abertura do alvo. Se `supportsBufferedDrain === false`, a captura/visualização do último quadro precede a parada destrutiva; não se promete que o vídeo antigo continue avançando nesse caso.

`PreparedLiveVideo.dispose()` retorna a Promise de destruição do transporte e só finaliza a limpeza do elemento depois dela. A propriedade `whenStopped` expõe essa mesma conclusão. O encerramento espera todas as Promises envolvidas, inclusive diante de erro; uma rejeição impede preparar o alvo. Adoção transfere também `result.engine` para que a aplicação mantenha o motor efetivamente preparado.

`registerTransportStop(promise)` é chamado de forma síncrona para registrar a destruição na barreira compartilhada da aplicação; pode retornar uma Promise de registro. A aplicação deve combinar o estado anterior da fila sem formar ciclo e preservar a espera de todo encerramento pendente antes de outra mídia. O fluxo conserva uma barreira própria e não reutiliza o standby durante a limpeza. A destruição do transporte ativo fora deste fluxo continua sendo responsabilidade da aplicação e precisa usar a mesma fila. Não basta chamar um `destroy()` assíncrono sem aguardar sua conclusão.

Número/logo/nome/programa continuam fornecidos pelos serviços existentes. A barra não calcula EPG, percentual, ETA ou buffer. Prontidão é estado/evento do elemento de mídia. Não foram criados Storage, tabelas, serviços externos, coleta paralela ou mudanças de backend. A sessão local não foi reiniciada.

Validação desta etapa: revisão de código, sintaxe e compilação em memória. Sem testes, navegador, reprodução ou operações remotas. O comportamento final em Safari/TV ainda precisa de conferência audiovisual autorizada.
