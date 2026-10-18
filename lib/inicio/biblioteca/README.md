# Biblioteca privada do início

`ConectorBibliotecaInicioSupabase` lê exclusivamente `arkhen_home_vod` com o JWT da conta ativa e as preferências autorizadas pelo servidor. A RPC fornece histórico VOD e a seleção de recomendações da Home; o DTO mantém `counts.live=0`, `history.live=[]` e `favoriteChannels=[]` por compatibilidade, mas a faixa atual de TV pertence a `lib/tv/home-conector-supabase.mjs` e à RPC `arkhen_home_tv`.

Este módulo não autentica o provedor, não coleta catálogo, não reproduz mídia e não consulta sugestões por filme. As sugestões da página do filme pertencem a `lib/filmes/recomendacoes/` e à RPC `arkhen_movie_recommendations`.

Cada leitura captura conta, cliente, geração de autenticação e estado do PIN. Uma conclusão tardia não pode atravessar essas fronteiras. Cancelamento e encerramento afetam somente as requisições deste módulo. A falha permanece indisponibilidade; uma lista vazia só é aceita dentro de um DTO válido. O orçamento HTTP existente de 10 segundos foi preservado, sem esconder timeout SQL com aumento de prazo.

Verificação sintética em 17/10/2026: `tests/private-projection-isolation.test.mjs`. A separação de módulos não comprova saúde do Supabase; migrations e medições remotas são registradas separadamente.
