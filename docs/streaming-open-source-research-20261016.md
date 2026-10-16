# Componentes abertos úteis para o streaming do ARKHEN

Consulta: **16/10/2026**. Evidência: documentação oficial, repositórios públicos dos mantenedores e leitura estática do ARKHEN. Não houve testes, navegador, reprodução, acesso a contas ou reinício.

## O que a pesquisa encontrou

Há componentes publicados pelos próprios desenvolvedores que permitem estudar partes de uma plataforma de streaming. As fontes abaixo não demonstram uma engenharia reversa completa da Netflix. O material útil é o código e a documentação de problemas específicos: qualidade de imagem, adaptação da transmissão, compatibilidade e preparação de mídia.

| Projeto e fonte primária | O que oferece | Aplicação possível no ARKHEN e limite |
| --- | --- | --- |
| [Netflix VMAF](https://github.com/Netflix/vmaf) e [uso com FFmpeg](https://github.com/Netflix/vmaf/blob/master/resource/doc/ffmpeg.md) | Métrica de qualidade visual desenvolvida pela Netflix. O fluxo documentado compara vídeo de referência com uma versão processada, com tempos e quadros alinhados. | **Futuro:** avaliar quanto uma compressão reduz qualidade e escolher combinações de resolução/bitrate, se houver um pipeline próprio de codificação e material de referência autorizado. VMAF não é player, buffer ou distribuidor de vídeo; não resolve uma origem que deixou de entregar dados. |
| [dash.js](https://github.com/Dash-Industry-Forum/dash.js), [ABR](https://dashif.org/dash.js/pages/usage/abr/settings.html), [BOLA](https://dashif.org/dash.js/pages/usage/abr/bola-rule.html) e [throughput](https://dashif.org/dash.js/pages/usage/abr/throughput-rule.html) | Player de referência para MPEG-DASH. A adaptação usa estimativas de transferência ou ocupação do buffer; a configuração padrão alterna entre as duas regras conforme o buffer. | **Princípio aproveitável:** decidir qualidade com dados reais de transferência/buffer e variantes reais da mesma transmissão. **Integração futura:** fontes DASH compatíveis. A rota TV atual entrega HLS (`.m3u8`), portanto dash.js não é uma substituição direta dessa rota. Instalar outro player não cria variantes de qualidade ausentes. |
| [Jellyfin: modos de reprodução](https://jellyfin.org/docs/general/post-install/transcoding/) | Diferencia reprodução original, troca de contêiner sem recodificar, conversão só de áudio e conversão de vídeo. A decisão considera as capacidades informadas pelo cliente. | **Princípio aproveitável:** identificar contêiner, codec e trilha incompatíveis antes de decidir uma transformação; conservar o original compatível. **Futuro:** remux/transcodificação no servidor somente quando o problema exigir. Instalar o servidor Jellyfin inteiro não é necessário para adotar esse princípio; uma transformação acrescentaria processamento e operação ao ARKHEN. |
| [AndroidX Media3 / ExoPlayer](https://developer.android.com/media/media3/exoplayer) e [PreloadManager](https://developer.android.com/media/media3/exoplayer/preloading-media/preloadmanager) | Componentes de reprodução/buffer para Android. O gerenciador de preload pode carregar conteúdo antes de sua seleção e priorizar itens próximos em uma lista. | **Futuro:** cliente nativo Android/Android TV. Não substitui o JavaScript do Safari/Chrome. Preload lê mídia e exige orçamento de memória, cancelamento e prioridade; não autoriza carregar vários canais remotamente sob o contrato atual de uma reprodução ativa. Preparar descritores não significa já ter quadros de vídeo. |

As aplicações propostas na última coluna são **inferências de engenharia**, não resultados medidos no ARKHEN. Nenhum desses componentes garante melhora automática de reprodução.

## O que existe agora e o que fica para outra etapa

O código inspecionado já possui HLS.js, HLS nativo e a rota Node autenticada. Na TV, [`preparePlayback`](../web/tv/orquestrador.js) consulta descritores de fontes; o vídeo é obtido posteriormente pela rota de reprodução. O [fluxo de continuidade](../web/player/troca-canal/continuidade/README.md) tem dois elementos locais e inicia a mídia alvo após STOP remoto, preservando somente o buffer finito do anterior. Essa observação é estática, sem certificação audiovisual.

**Entrega desta pesquisa:** este documento e suas fontes. VMAF, dash.js, Jellyfin e Media3 não foram instalados, ativados ou publicados por esta tarefa. O adaptador Shaka é uma implementação separada em andamento; sua presença no código, ativação e validação devem ser informadas pela entrega correspondente.

Para a etapa atual, a aplicação proporcional é manter a interface do ARKHEN e adaptar a engine de reprodução sem perder identidade do conteúdo, conta/PIN, cancelamento, STOP/sid, tentativa de reprodução e posição VOD. O backend atual continua responsável pela fonte autorizada. A troca de engine não substitui essa responsabilidade nem aumenta a capacidade da origem ou da conexão.

As outras etapas dependem de uma necessidade concreta: dash.js para DASH; VMAF para avaliar codificações próprias; remux/transcodificação para incompatibilidade comprovada; Media3 para um aplicativo nativo. Esta pesquisa não altera a recuperação de falhas nem retoma a investigação da repetição de trechos que o usuário pediu para encerrar.
