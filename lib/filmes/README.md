# Backend de Filmes

`orquestrador.mjs` atende apenas detalhes de filme, catálogo/modelo de Filmes e recomendações por filme, depois da guarda compartilhada do provedor. `servicos.mjs` compõe esses leitores; `catalogo.mjs` mantém paginação, revisão, classificação e fallback; `metadados.mjs` controla a consulta selecionada de detalhes/arte/duração; `conector-supabase.mjs` contém a RPC privada de recomendações e adapta os leitores compartilhados de catálogo.

`recomendacoes-request.mjs` valida de 1 a 10 resultados (padrão 10). O endpoint exige ranking versão 2 da RPC e sinaliza indisponibilidade em falha; não ranqueia o catálogo carregado. `recomendacoes-sessao.mjs` permanece somente como implementação legada de compatibilidade, fora desse endpoint. Os caminhos antigos desses dois módulos são fachadas da mesma implementação.

O catálogo nativo WPLAY permanece compartilhado com Séries em `../vod/catalogo-nativo.mjs`, com mapas e gerações separados por tipo. `../wplay-vod.mjs` conserva seus exports de compatibilidade. Nenhum catálogo de Séries foi colocado neste domínio.

Play, stop, status, proxy, Range, sessão e a sonda MP4 continuam compartilhados. Estes módulos não criam engine, transporte OTT de TV, EPG, nova sessão ou fila de mídia. A modularização foi conferida por leitura, sintaxe e bundles não executados; não certifica reprodução ou disponibilidade remota.

Contratos, integração e limites: [relatório de 16/10/2026](../../docs/movies-backend-modularization-20261016.md).

Ranking, migration local e revisão antes de publicação: [recomendações versão 2](../../docs/movies-recommendations-ranking-20261016.md).
