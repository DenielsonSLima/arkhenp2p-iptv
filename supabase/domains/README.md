# Contratos SQL por domínio

As migrations em `../migrations/` continuam sendo a única fonte executável de alterações. Estas pastas indicam o responsável por cada RPC e suas dependências; não duplicam corpos de funções que possam divergir.

- [Início VOD](inicio-vod/README.md): histórico, contagens e recomendações gerais de Filmes/Séries.
- [Canais do Início](tv-inicio/README.md): destaque semanal e quatro canais recentes.
- [Sugestões de um filme](filmes-recomendacoes/README.md): relação entre a obra aberta e outras obras.

Uma nova revisão de TV não invalida VOD. Uma falha no preparo de TV não bloqueia as sugestões de Filmes. Autorização e biblioteca são privadas por conta; somente modelos editoriais de catálogo são compartilhados.
