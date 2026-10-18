# Sugestões de um filme

RPC `public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb)`.

Fonte atual do leitor e preparo: [mapa por geração](../../migrations/20261016051752_arkhen_movie_recommendations_snapshot_memberships.sql). Identidade editorial v2: `20261016045808`; campos e contratos anteriores permanecem nessa cadeia de migrations.

A consulta recebe o ID nativo do filme aberto, limite e ocultações. Retorna `schemaVersion: 1`, `rankingVersion: 2`, `identityVersion: 2` e até dez filmes. Franquia/universo, gênero/categoria e histórico obedecem à ordem SQL existente; o navegador não inventa outro ranking após uma falha.

O mapa editorial global `movieIdentityV2` pertence à geração de Filmes. Biblioteca, progresso, ocultações e a resposta personalizada continuam privados por conta. `SECURITY INVOKER`, RLS, `search_path=''`, ACL autenticada e SQL de oito segundos são preservados.

Essa RPC não chama `arkhen_home_vod`, `arkhen_home_library` nem `arkhen_home_tv`. Falha transitória de sessão, RPC ou preparo é indisponibilidade; não deve ser apresentada como uma busca bem-sucedida sem sugestões. Nenhuma nova migration de ranking faz parte do isolamento da Home em 17/10.
