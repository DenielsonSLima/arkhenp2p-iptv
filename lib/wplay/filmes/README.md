# WPLAY Filmes

`servicos.mjs` consulta catálogo, página e detalhes de Filmes usando a conexão
injetada. O kernel `../vod/catalogo-nativo.mjs` mantém sua geração separada de
Séries; o modo legado compartilha uma única leitura de metadados VOD.

`duracao.mjs` contém a sonda MP4 limitada de um filme selecionado. O estado
continua pertencendo ao mesmo cliente: iniciar/parar mídia cancela a sonda.
Ela não inicializa TV/OTT, baixa o filme completo ou mede duração de Séries.

Rotas, RPC de recomendações, autorização e cache de produto ficam em
`lib/filmes/`; a reprodução usa o transporte compartilhado.
