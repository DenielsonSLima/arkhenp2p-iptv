---
name: arkhen-realtime
description: Sincronizar biblioteca e revisões de catálogo do ARKHEN com Supabase Realtime sem invalidar ou renderizar domínios não relacionados.
---

Use a skill oficial Supabase disponível e leia `docs/engineering-recovery.md` para as decisões do projeto.

Favoritos, progresso, coleções e preferências são privados por usuário e protegidos por RLS. Subscribe/unsubscribe acompanha a conta atual; callbacks de sessão anterior não podem escrever na próxima conta.

Eventos pessoais atualizam seletores pessoais. Progresso não recarrega Filmes/Séries/TV. Eventos globais identificam o tipo/revisão e preservam o TTL do snapshot diário conforme a política do produto.

Prefira avisos pequenos de revisão aos broadcasts de dezenas de milhares de metadados. Coalesça trabalho repetido e faça um commit visual por mudança relevante, preservando foco e scroll.

Verifique duas sessões, troca de conta, eventos repetidos, reconexão e atraso. Não declarar Realtime funcional apenas porque um canal foi inscrito.

Referência: [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).
