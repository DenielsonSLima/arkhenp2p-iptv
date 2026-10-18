# Trabalho no ARKHEN

As instruções do usuário e o escopo da tarefa prevalecem sobre estas convenções.

- Antes de mudanças não triviais, use [arkhen-memory-rag](skills/arkhen-memory-rag/SKILL.md) para recuperar somente a memória do domínio relevante. Comece pelo [índice](docs/memory/index.md).
- Para implementação ou revisão de arquitetura, use [arkhen-senior-engineering](skills/arkhen-senior-engineering/SKILL.md). Preserve os contratos de Filmes, Séries, TV e biblioteca pessoal.
- Integração WPLAY: [IPTV](skills/arkhen-iptv/SKILL.md) e [P2P](skills/arkhen-p2p/SKILL.md). Operações Supabase: [skill do projeto](skills/arkhen-supabase/SKILL.md) e skills oficiais disponíveis.
- Diagnóstico Supabase: priorize saúde e estatísticas PostgreSQL limitadas, sem consultas de logs por padrão. Não fazer polling com `query_logs`, `get_logs`, Logs Explorer ou API de logs. Se logs forem indispensáveis, use projeto/serviço e intervalo explícito do incidente, começando por 5–15 minutos, e reutilize o resultado sanitizado. `LIMIT` não substitui intervalo temporal. Ver [revisão de consumo](docs/supabase-log-query-review-20261016.md).
- Registre decisões duráveis com fonte, data e nível de evidência em `docs/memory/`. Evidência histórica não certifica estado remoto ou reprodução atual.
- A memória não inclui `.local`, credenciais, URLs privadas de mídia, biblioteca ou progresso pessoal. A proibição atual de testes e navegador deve ser respeitada enquanto permanecer no pedido do usuário.
