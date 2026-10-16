# Aba de Séries

`orquestrador.js` conserva o estado de navegação de Séries sobre `CatalogFeature`, em `../sistema/catalogo/aba.js`. `services.js` limita as cargas ao catálogo `series`, reutilizando repositório, conta, cache e cancelamento existentes. O nome da pasta não muda o identificador de API `series`.

A aba está integrada. Temporadas, episódios, marcadores, miniaturas, progresso e reprodução continuam nos componentes já existentes; essa organização de tela não declara sua migração completa. Preferências de reprodução têm apresentação em `../sistema/configuracoes/series.js`; a biblioteca e o player permanecem compartilhados. Carregar Séries não inicializa TV/EPG.

Veja o [mapa atual](../../docs/system-modularization-20261016.md).
