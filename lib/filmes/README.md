# Backend de Filmes

`orquestrador.mjs` atende apenas detalhes de filme, catálogo/modelo de Filmes e recomendações por filme, depois da guarda compartilhada do provedor. `servicos.mjs` compõe esses leitores; `catalogo.mjs` mantém paginação, revisão, classificação e fallback; `metadados.mjs` controla a consulta selecionada de detalhes/arte/duração; `conector-supabase.mjs` adapta os leitores compartilhados de catálogo e delega recomendações ao módulo independente `recomendacoes/`.

`recomendacoes/request.mjs` valida de 1 a 10 resultados (padrão 10), com fachada compatível em `recomendacoes-request.mjs`. `recomendacoes/servico.mjs` mantém a política de indisponibilidade e autorização do resultado. `recomendacoes/conector-supabase.mjs` é o único dono da RPC `arkhen_movie_recommendations`, dos leitores simultâneos e de seu cancelamento. O endpoint exige ranking versão 2 da RPC e sinaliza indisponibilidade em falha; não ranqueia o catálogo carregado. `recomendacoes-sessao.mjs` permanece somente como implementação legada, fora desse endpoint.

A Home usa `lib/inicio/biblioteca/conector-supabase.mjs` com `arkhen_home_vod`. A seleção de canais usa `lib/tv/home-conector-supabase.mjs` com `arkhen_home_tv`. As três consultas têm ciclos de vida independentes; falhar ou cancelar uma não encerra as outras. `tests/private-projection-isolation.test.mjs` cobre esse contrato, a entrega tardia após troca de conta/PIN e a distinção entre resposta vazia válida e indisponibilidade.

O adaptador Filmes do provedor fica em `../wplay/filmes/servicos.mjs`; catálogo nativo e carregamento VOD legado são compartilhados com Séries em `../wplay/vod/`, com mapas e gerações separados por tipo. As antigas fachadas `wplay-vod.mjs` foram removidas após migração dos consumidores. Nenhum catálogo de Séries foi colocado neste domínio de produto.

Play, stop, status, proxy, Range, sessão e a sonda MP4 continuam compartilhados. Estes módulos não criam engine, transporte OTT de TV, EPG, nova sessão ou fila de mídia. A modularização foi conferida por leitura, sintaxe e bundles não executados; não certifica reprodução ou disponibilidade remota.

Contratos, integração e limites: [relatório de 16/10/2026](../../docs/movies-backend-modularization-20261016.md).

Ranking, migration local e revisão antes de publicação: [recomendações versão 2](../../docs/movies-recommendations-ranking-20261016.md).
