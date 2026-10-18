# Backend de Séries

`orquestrador.mjs` assume somente catálogo, modelo de navegação e detalhes `type=series` nas rotas autenticadas existentes. `catalogo.mjs` mantém paginação, geração, cache, classificação e leitura alternativa autorizada do mesmo domínio. `metadados.mjs` lê a série selecionada, suas temporadas/episódios e a projeção limitada de arte, sem abrir um episódio para inferir duração da série.

Os leitores recebem o `CloudRuntime`, busca de catálogo, sessão WPLAY e controle parental existentes. Respostas atrasadas são descartadas após mudança de conta, geração, PIN, cancelamento ou encerramento. O adaptador do provedor fica em `../wplay/series/`: serviço de catálogo/detalhes e registro dos episódios por ID nativo. O núcleo VOD compartilhado fica em `../wplay/vod/`; IDs e fontes não são reconstruídos neste módulo de produto.

Play, stop/status, Range, proxy, engine Atual/Shaka e conexão do provedor continuam compartilhados. Estes arquivos não inicializam EPG/TV, outro cliente Auth, transporte ou relógio de progresso. Verificação sintética local não comprova mídia ou disponibilidade do provedor/banco.
