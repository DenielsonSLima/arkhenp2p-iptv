# Continuidade na troca: buffer local, RAM e Supabase

Data: 16/10/2026. Estado: análise de arquitetura por código local e documentação pública oficial. Não implementa cache novo, dois vídeos ou coleta de mídia. Sem dados da conta, reprodução, testes, navegador, reinício ou mutação remota. Três agentes especializados participaram da reunião com o agente principal.

Atualização posterior no mesmo dia: a recomendação de dois elementos locais foi implementada em [web/player/troca-canal/continuidade](../web/player/troca-canal/continuidade/README.md), após autorização do usuário e com quatro agentes auxiliares. A análise abaixo registra o diagnóstico anterior; a implementação não adiciona cache remoto e permanece sem prova audiovisual.

## Conclusão

Supabase Storage pode guardar e servir arquivos privados temporários, mas a obtenção dos segmentos e a troca do vídeo ativo continuam necessárias. Para a ponte de poucos segundos entre canais, a recomendação é aproveitar o buffer local e, somente se necessário, RAM privada do Node. O ganho audiovisual ainda precisa ser demonstrado; guardar bytes não comprova mídia decodificada.

## O que o projeto já possui

`lib/provider.mjs` mantém cache privado por cliente/sessão: segmento completo de até 8 MiB, total de até 32 MiB e validade de 60 segundos. `stopPlayback` e mudança de playback limpam o cache. `/api/asset` em `lib/app-server.mjs` valida a identidade ativa. Isso evita downloads repetidos dentro da reprodução, mas não constitui uma janela antiga reproduzível após STOP.

O frontend preserva o atual apenas durante `liveSources`, que retorna descritores. Depois, `web/app.js` destrói HLS e limpa o elemento de vídeo. Controles, eventos e o grafo WebAudio retêm esse elemento fixo. HLS 1.6.13 permite parar downloads mantendo buffer local, mas `transferMedia` não promove um elemento standby para o principal. O caminho nativo tem comportamento próprio.

## Comparação

| Alternativa | Benefício possível | Limite |
| --- | --- | --- |
| Buffer do navegador atual | Já está perto do decoder; dispensa upload. | Finito; acaba se o alvo demorar. |
| RAM Node privada | Pode preservar os segmentos recebidos para leitura posterior. | Precisa namespace aposentado somente leitura, validade, limite, autorização e proibição de voltar à origem antiga. |
| Storage privado | Arquivos temporários acessíveis entre componentes/dispositivos. | Acrescenta upload/download, limpeza e gestão de acesso; não obtém nem decodifica o alvo sozinho. |
| Primeiro fragmento do alvo | Pode antecipar parte da transferência antes do handoff. | Fragmento baixado não comprova quadro pronto; init, áudio e outras dependências podem ser necessários. |
| Dois vídeos locais com uma fonte remota | Antigo consome dados recebidos enquanto alvo carrega; promoção no quadro real. | Exige propriedade explícita de controles, áudio, eventos e cancelamento; buffer antigo continua finito. |
| Duas fontes remotas simultâneas | Atual pode continuar recebendo enquanto alvo prepara. | Depende de capacidade/autorização comprovada do provedor; não demonstrada nesta sessão. |

Manter cinco segundos recentes dos dois vizinhos implica captar os dois canais continuamente enquanto o atual também é recebido. Mudar o destino dos bytes para RAM ou Storage não elimina essa captação. Trecho da visita anterior fica defasado e não representa o sinal atual do canal.

Exemplo puramente ilustrativo, sem medir a assinatura: a 8 Mb/s, cinco segundos equivalem a aproximadamente 5 MB por canal. Renovar essa janela continuamente preserva o tráfego do bitrate inteiro; retenção curta reduz espaço ocupado, não a necessidade de receber vídeo.

## Por que Storage não é a primeira escolha

A [documentação de arquivos privados](https://supabase.com/docs/guides/storage/serving/downloads) descreve acesso autenticado ou URL assinada. Isso viabiliza servir arquivos, mas não fornece um coletor de TV ao vivo. No projeto, fontes/cookies permanecem no backend da sessão; o namespace global de EPG/artwork não deve ser usado para vídeo privado.

O [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn) pode levar até 60 segundos para propagar a invalidação de um objeto alterado. Esse prazo não é uma demora obrigatória de todo download: segmentos imutáveis com nomes únicos evitariam depender da sobrescrita. Tokens assinados distintos também têm entradas de cache independentes. Um eventual design teria de gerenciar manifesto atualizado, retenção e exclusão, não apenas sobrescrever um arquivo a cada cinco segundos.

As [Edge Functions hospedadas](https://supabase.com/docs/guides/functions/limits) têm limites de memória e duração do worker; não são, por si, um relay permanente. Inferência arquitetural: se um serviço contínuo de ingestão fosse necessário, ele deveria ter ciclo próprio, reconexão e autorização explícitos. Nesta análise não se propõe criar esse serviço nem usar conta de outro dispositivo para alimentar cache global.

## Evolução recomendada

1. Separar elemento visível de elemento em preparação, mantendo o domínio TV isolado de VOD.
2. No caminho HLS controlável, parar downloads do antigo e confirmar STOP remoto, preservando seu buffer e áudio locais.
3. Abrir somente o alvo como nova fonte remota em outro elemento local.
4. Promover imagem/áudio após evento real de quadro do alvo, com migração explícita de controles e listeners. Não inferir prontidão de descritor, relógio ou percentual.
5. Encerrar o slot antigo. Se seu buffer acabar antes da prontidão, apresentar espera discreta ou quadro parado identificado; não repetir trecho antigo como se fosse sinal ao vivo.

Esse desenho pode reduzir a interrupção com uma fonte remota, mas não garante continuidade ilimitada. Garantir que o antigo continue recebendo até o novo decodificar exige simultaneidade remota suportada. O frontend continua sem calcular programação, ETA ou porcentagem: backend controla autorização/identidade e o elemento de mídia informa sua prontidão real.

Fontes de código: `lib/provider.mjs`, `lib/app-server.mjs`, `lib/wplay-playback.mjs`, `lib/wplay-ott-provider.mjs`, `web/app.js`, `web/audio-processing.js`, `web/assets/vendor/hls.min.js` e [contrato da barra](../web/player/troca-canal/README.md). Documentação pública consultada em 16/10/2026; não se verificaram plano, limites particulares da conta ou desempenho real.

## Opções gratuitas consultadas após a implementação

Pesquisa em 16/10/2026, limitada às fontes oficiais; nenhuma dependência foi adicionada ou serviço conectado.

| Opção | Ajuda possível | Decisão nesta etapa |
| --- | --- | --- |
| [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) | Informa o envio de um quadro ao compositor. | Já usado na preparação; quando o navegador não entrega esse callback ao standby, exige-se mídia atual real, dimensões e ausência de erro. [HAVE_CURRENT_DATA](https://html.spec.whatwg.org/multipage/media.html#dom-media-have_current_data) define disponibilidade do quadro atual. |
| [Media Capabilities](https://w3c.github.io/media-capabilities/) | Informa suporte, fluidez e eficiência estimada para configuração conhecida de codec/resolução/bitrate. | Candidato futuro para compatibilidade; requer dados confiáveis do manifesto. Não é prova de prontidão nem medição da rede. Não implementado. |
| [Shaka Player](https://github.com/shaka-project/shaka-player), Apache2.0 | Biblioteca HLS/DASH gratuita; [Preload API](https://shaka-project.github.io/shaka-player/docs/api/tutorial-preload.html) antecipa manifesto e primeiros segmentos. | Alternativa investigada, sem migração. A documentação exclui desse preload o HLS nativo no Safari. Pré-carregamento ainda solicita mídia e não comprova quadro decodificado. |
| [HLS.js](https://github.com/video-dev/hls.js), Apache2.0 | Transporte MSE já presente no produto. | Mantido, sem atualização da versão embarcada. A nova adoção reutiliza sua instância pronta. |

Recomendação arquitetural: conservar HLS.js e a prontidão local nesta etapa; avaliar Media Capabilities quando os metadados necessários estiverem comprovados. A pesquisa não identificou um serviço gratuito que resolva sozinho a continuidade sob o contrato de uma fonte remota. Trocar de biblioteca ou guardar bytes não elimina a obtenção autorizada dos segmentos e a prontidão no dispositivo. Essa última conclusão é uma inferência do fluxo e dos limites descritos, não um levantamento exaustivo de serviços.
