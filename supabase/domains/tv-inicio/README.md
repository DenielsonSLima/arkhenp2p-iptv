# Canais do Início

Entrada atual: `public.arkhen_home_tv_catalog(text,text,text[],text[])`.

Fonte: [migration de autoridade do catálogo](../../migrations/20261017161618_arkhen_home_tv_catalog_authority.sql).

A entrada recebe provedor, escopo e ocultações. Os IDs vêm da geração publicada de TV dentro do PostgreSQL, em uma leitura limitada de IDs, sem baixar o catálogo completo para Node. Mais de dois mil canais produz indisponibilidade explícita; a função não retorna uma seleção silenciosamente truncada.

O ranking continua em `arkhen_home_tv`: um destaque dos últimos 168h e até quatro recentes, Globo como padrão quando não há destaque medido. A validação final confere conta/partição, geração, disponibilidade, conteúdo adulto e ocultações. Metadados de Filmes/Séries não participam dessa consulta.

A entrada nova é `SECURITY INVOKER`; a implementação de ranking conserva o contrato anterior de `SECURITY DEFINER` com validações explícitas de conta. Ambas mantêm ACL autenticada e SQL de três segundos. A nova entrada não escreve histórico, sessões, contadores ou buckets e não modifica `arkhen_tv_watch_heartbeat`.

O backend ainda valida a sessão e capacidades do provedor. A autoridade de heartbeat/reprodução continua separada: obter cards não autoriza uma sessão de vídeo.
