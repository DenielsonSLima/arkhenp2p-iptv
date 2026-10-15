---
name: arkhen-tanstack
description: Organizar queries, cache diário e invalidação por domínio no ARKHEN com TanStack Query Core e IndexedDB.
---

Leia `docs/engineering-recovery.md` e a integração existente de `@tanstack/query-core`; não presumir React ou adicionar outro gerenciador de estado.

Query keys de catálogo incluem projeto, provedor, escopo, tipo e bloqueio adulto. Queries de biblioteca incluem usuário/propriedade; não compartilhe dados privados usando uma chave global de catálogo.

O catálogo completo tem TTL de 24 horas no cache persistente solicitado pelo usuário. Frescor em memória e retenção de queries não substituem IndexedDB. `staleTime` e `gcTime` têm finalidades distintas; confira os defaults oficiais antes de alterar.

Refetch não limpa dados válidos. Uma prévia, resposta de revisão antiga ou outra conta não substitui snapshot completo. Erros não renovam o TTL. Realtime de progresso/favorito não invalida todos os catálogos.

Teste deduplicação de requisições, reload sem nova leitura do catálogo fresco, vencimento diário, fallback offline e isolamento de conta/tipo/adulto.

Referência: [defaults do TanStack](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults).
