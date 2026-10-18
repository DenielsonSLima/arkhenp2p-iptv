# Número, programa, resolução e hora no player de TV

Data:18/10/2026. Estado: implementação local com inspeção e sintaxe; sem testes, navegador ou certificação audiovisual.

O rodapé mostra número configurado do canal, nome do programa e resolução medida do vídeo atual. Sem EPG, usa o nome do canal e esconde somente a barra e o intervalo de programação. A numeração vem do contrato existente do player, preservando personalizações; não usa o ID do provedor nem a posição da qualidade.

Dimensões são aceitas depois da prontidão da reprodução atual, com atualização em metadata/resize e limpeza durante troca/carregamento. Enquanto não há vídeo medido, o badge mostra `—`. Rótulos do nome, como HD ou FHD, não viram uma medição. A revisão rejeitou usar `channelQualityRank`, cujo ranking agrupa algumas alturas declaradas e não preserva a resolução literal.

Um relógio `HH:mm` fica nos controles inferiores, à direita do espaço flexível. Usa hora local do aparelho, sem interferir no EPG do servidor. Um timeout acompanha a virada do minuto, suspende quando a página fica oculta e é removido ao fechar/destruir o player. Filmes e Séries não exibem o relógio de TV.

Três agentes participaram: implementação dos metadados, implementação do relógio e revisão estática. A integração foi revista pelo coordenador. Não houve reinício do servidor ou interação com a sessão do usuário.

Fontes: `web/player/orquestrador.js`, `web/tv/player/metadados.js`, `web/tv/player/relogio.js`, `web/tv/player/relogio.css`, `web/player.css`, `web/playback-page.css` e `web/index.html`.
