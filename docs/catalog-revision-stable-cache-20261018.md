# Cache de revisão após restauração de sessão

Data: 18/10/2026. Estado: implementação local; revisão estática, sem testes, navegador ou consulta remota nesta frente.

`CatalogRevisionService` usava a identidade do objeto de conta em sua chave de cache. A sessão distribuída restaura um novo objeto a cada requisição HTTP, mesmo quando a autorização permanece igual. Isso impedia reutilizar o cache positivo de um segundo e a espera de trinta segundos após falha dentro da mesma instância.

A chave agora inclui provedor, escopo, tipo de catálogo, geração de autenticação e SHA-256 do token de acesso. O digest permanece somente na memória do processo, sem retorno ao navegador, logs ou persistência. Tokens diferentes não compartilham falhas. A entrega continua verificando as referências atuais de conta e cliente, a geração, o PIN e o cancelamento de cada consumidor.

Os prazos, a consulta limitada de metadados e o limite de entradas permanecem os mesmos. Instâncias diferentes continuam tendo caches independentes. A alteração reduz trabalho repetido dentro de uma instância; não certifica disponibilidade do Supabase nem resolve uma falha de Auth ou do banco.

Fontes: `lib/catalog-revision-service.mjs`, `lib/runtime-session-state.mjs` e `lib/runtime-session-store.mjs`.
