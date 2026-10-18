# WPLAY Séries

`servicos.mjs` mantém o leitor tipado de catálogo, página e detalhes de Séries.
Usa a mesma autenticação e o kernel VOD comum, com geração e paginação próprias.

`episodios.mjs` interpreta temporadas/episódios fornecidos pelo serviço,
deduplica variantes da mesma edição e registra a fonte privada por ID nativo.
O DTO público não inclui endereços. A duração do episódio não é aplicada à série
e nenhuma sonda MP4 é iniciada para calcular o tempo da série inteira.

Busca, UI, sequência, biblioteca e marcadores permanecem nos módulos de produto
`web/serie/`, `lib/serie/` e no domínio de marcadores. Este adaptador não replica
o store de progresso, a conexão Supabase ou o player.
