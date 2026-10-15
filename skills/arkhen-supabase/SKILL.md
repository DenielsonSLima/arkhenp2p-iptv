---
name: arkhen-supabase
description: Manter dados, filas e publicações de Filmes/Séries/TV do ARKHEN isolados no projeto Supabase autorizado.
---

Use as skills oficiais Supabase e Postgres da sessão. Leia `docs/engineering-recovery.md` antes de mudar schema, filas ou publicações.

Confirme o projeto autorizado `wnicimkmzswksaqdtgdv`; uma conexão MCP com outra conta não autoriza mutações nela. Chaves de servidor ficam na Edge/ambiente confiável, fora de navegador, logs e arquivos versionados.

Dados globais usam provedor/escopo/tipo. Tarefas `live`, `movies` e `series` precisam de leases, tentativas, cursores e revisões independentes. Um typeReady de Filmes não bloqueia Séries. Biblioteca/progresso nunca entram em tabelas globais.

Preserve staging e snapshot válido em falha. Preparação privada não é publicação completa. Avalie SQL com RLS, limites, idempotência, custos por fase e publicação real; um benchmark local não comprova a conclusão do job remoto.

Antes de outro ajuste por timeout, obtenha código e duração por fase sem payloads/segredos. Faça mudanças proporcionais e revisão do diff; não aumentar limites globais para ocultar uma operação não medida.
