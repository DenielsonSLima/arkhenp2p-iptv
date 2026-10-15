# Contorno da superfície do player

O contorno claro vinha de `.immersive-stage:focus-visible` em `web/player.css`, com outline de 2 px para dentro. A área recebe foco ao abrir o player e ao tocar no vídeo para permitir comandos por teclado/controle remoto. Também existia um outline global de `video:focus-visible` em `web/cinema.css`.

`web/player-surface.css`, carregado depois dos estilos do player, remove outline, borda e sombra somente do stage e de seu vídeo direto. As mesmas regras continuam válidas no fullscreen padrão e WebKit, pois os elementos mantêm suas classes e relação no DOM. O fundo de fullscreen é preto. Nenhum seletor alcança botões, menus ou controles de volume/progresso: seus indicadores de foco permanecem.

Verificação de código: origem dos dois outlines identificada e seletores restritos conferidos. Nenhum navegador foi aberto. A conferência visual posterior deve comparar player normal/fullscreen, faixas pretas e foco de botões/ranges com Tab/controle remoto.
