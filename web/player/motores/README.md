# Escolha do player

Implementação local de 16/10/2026. Configurações → Player oferece somente **Atual** e **Shaka**. Atual permanece como padrão; não há escolha automática entre bibliotecas.

| Arquivo/pasta | Responsabilidade |
| --- | --- |
| `preferencias.js` | Escolha local por navegador, sem sincronização de catálogo ou conta. |
| `configuracoes.js` | Rádios acessíveis e aviso de aplicação ao próximo conteúdo. |
| `orquestrador.js` | Resolve o transporte, carrega a distribuição local sob demanda e verifica suporte. |
| `distribuicao.js` | Versão e integridade da distribuição vendorizada, geradas pelo build. |
| `shaka/` | [Ciclo de vida, configuração, faixas e erros do Shaka](shaka/README.md). |

O player visual, volume, pausa, teclado e grade continuam nos módulos existentes. A escolha é capturada antes de encerrar a reprodução atual; mudar o rádio não reabre mídia. Recuperação e mudança de fonte conservam a escolha daquela abertura. Próximo conteúdo lê a preferência atual.

Shaka **5.2.13**, Apache-2.0, fica em `web/assets/vendor/shaka-player.compiled.js`. `npm run build:shaka` reproduz a cópia oficial, licença e SHA-384 usando a versão fixada em package-lock. Não é carregado no caminho Atual, não exige CDN, nova API paga, servidor adicional, alteração de CSP ou reinício do backend. Falha no carregamento/suporte informa como selecionar Atual, sem migrar silenciosamente.

TV mantém seus descritores/EPG/STOP; Filmes e Séries conservam posição, episódios, legendas e políticas próprias. Aberturas Shaka recebem somente rotas de mídia locais já autenticadas. HLS usa seu transporte compatível; arquivos simples podem usar o caminho nativo do próprio Shaka. A biblioteca não converte codecs nem cria variantes que o provedor não forneceu.

Na confirmação lateral, [continuidade](../troca-canal/continuidade/README.md) resolve o motor antes de parar o canal anterior. Encerramentos assíncronos entram na barreira local e precedem nova mídia. Uma falha de encerramento impede nova abertura até recarregar a página. O caminho HLS.js conserva seu buffer finito; o encerramento Shaka é destrutivo e conserva somente o último quadro capturável durante a espera. Não há segunda reprodução remota para compensar esse limite.

Verificação desta etapa: revisão de código, sintaxe e compilação em memória. Não houve testes, navegador, reprodução audiovisual, contratação, publicação remota ou reinício da sessão. Compatibilidade e benefício contra travamentos ainda dependem de avaliação nos aparelhos reais.

Fontes: [distribuição 5.2.13](https://github.com/shaka-project/shaka-player/releases/tag/v5.2.13), [uso e suporte](https://shaka-project.github.io/shaka-player/docs/api/tutorial-basic-usage.html), [rede e buffer](https://shaka-project.github.io/shaka-player/docs/api/tutorial-network-and-buffering-config.html).
