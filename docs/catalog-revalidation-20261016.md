# Revalidação compacta de catálogo — 16/10/2026

Estado: implementação local; revisão e sintaxe estáticas, sem teste automatizado, navegador, mídia ou publicação desta etapa. O incidente remoto de CPU não é declarado resolvido por estas mudanças.

## Problema e mudança concreta

IndexedDB, TTL de 24 horas, snapshots imutáveis e RAM/Query Core já existiam. A revalidação diária ou por Realtime, porém, podia transferir novamente todos os títulos mesmo quando a publicação continuava igual. Esta etapa acrescenta uma consulta pequena de identidade antes de ler os dados completos.

O cliente preserva o catálogo atual enquanto valida `snapshotId + revisionAt + mediaType + includeAdult`. Igualdade permite reutilizar os bytes locais; mudança exige um snapshot completo, aceito atomicamente. Uma falha não vira catálogo vazio, não renova a idade do download e não inicia outro refresh do provedor por este endpoint.

## Contrato de revisão

`GET /api/catalog/revision?type=live|movies|series` retorna somente:

```text
{ mediaType, snapshotId, revisionAt, expiresAt, includeAdult, complete: true }
```

`lib/catalog-revision-service.mjs` seleciona os campos de identidade/estado/contagem de uma linha de `provider_catalog_cache`, sem `payload`. Usa token do usuário/RLS, partição e tipo; guarda cliente, referência da conta, geração de autenticação e PIN depois do await. A rota normal não faz novo `client.connect`, provisionamento Auth, coleta WPLAY ou enqueue de atualização. O transporte tem orçamento de 3 segundos, coalescência por conta/partição/tipo, cache positivo de 1 segundo e de falha de 30 segundos. Ausência/preparação/falha retorna indisponibilidade, sem um falso `complete:false` bem-sucedido.

A API de snapshot/read-model existente normaliza `revisionAt` a milissegundos. O cliente mantém essa comparação também para hints Realtime com frações PostgreSQL. A identidade UUID é comparada separadamente para distinguir publicações diferentes no mesmo milissegundo; não se inventa ordenação entre UUIDs.

## Responsabilidades do cliente

| Arquivo | Responsabilidade nesta etapa |
| --- | --- |
| `web/catalog-revision.js` | Valida o DTO compacto, compara revisões e reconhece um catálogo completo/versionado. Não transporta dados nem abre outro SDK. |
| `web/catalog-repository.js` | `checkRevision(ticket,reader,options)` usa os tickets/epochs existentes; coalesce checagem do mesmo ticket; retorna estado explícito e mantém cooldown de falha de 30 segundos. |
| `web/catalog-cache.js` | Lê/grava confirmação compacta em chave separada no objectStore existente, sem mudar schema, copiar o catálogo inteiro ou alterar `savedAt`. |
| `web/sistema/catalogo/realtime.js` | Aceita somente domínio válido, agrupa hints por revisão/UUID, rejeita antigas/duplicadas e usa orçamento limitado de retries. |
| `web/cloud-library.js` | Encaminha o `snapshot_id` do ponteiro publicado no evento compacto; não acrescenta assinatura/tabela de títulos. |
| `web/app.js` | Integra hidratação, cabeçalho, download condicional e orçamento diário; propriedade do orquestrador principal, separada do módulo de cache. |

`CatalogRepository.checkRevision` retorna:

- `unchanged`: publicação igual; catálogo atual, publicação confirmada e `verifiedAt`.
- `changed`: publicação diferente, com identidade exigida para o download seguinte.
- `missing`: catálogo local não possui publicação completa utilizável; segue o carregamento normal.
- `unavailable`/`cooldown`: preserva o completo e informa `retryAt`; não pede outro corpo completo para contornar falha do cabeçalho.

Um hint que exige publicação ainda não vista não pode confirmar o snapshot local anterior. Um cabeçalho claramente mais novo pode superar o hint. Quando o timestamp é igual e UUIDs diferem, mantém-se a postura conservadora e uma nova tentativa resolve a corrida, sem tratar o UUID como contador temporal.

Após `changed`, o ticket conserva a publicação mínima exigida. `fetch()` rejeita uma resposta completa anterior, sem identidade ou com timestamp igual/UUID diferente do alvo. Isso evita renovar o TTL com uma leitura completa antiga que já estivesse em voo no servidor. Resposta de publicação claramente posterior pode ser aceita. O orquestrador também pede `cache=reload` quando o cabeçalho mudou; forçar somente Query Core não invalidaria o cache HTTP/servidor.

## Idades, erro e IndexedDB

`savedAt` continua sendo a data em que os bytes completos foram recebidos. `verifiedAt` registra uma confirmação autenticada de que aqueles mesmos bytes ainda representam a publicação. A verificação tem chave pequena independente, contendo somente escopo, DTO de publicação e data; não inclui conta, favoritos, progresso, credenciais ou fontes de reprodução.

A leitura considera a confirmação apenas se escopo, UUID, revisão e acesso adulto coincidirem com o snapshot; a data deve ser válida, posterior ou igual a `savedAt` e sem avanço de relógio indevido. A frescura diária usa `max(savedAt,verifiedAt)`. Falha de rede/DTO/armazenamento não cria nova confirmação. O armazenamento indisponível permite manter a cópia RAM durante a sessão.

Se o navegador remover apenas a confirmação, o catálogo permanece utilizável e outra consulta de revisão recompõe a confirmação. Se remover o catálogo, um registro de confirmação solto não permite simular conteúdo: será necessário um snapshot completo. `clear`/bloqueio adulto apagam catálogo e confirmação daquele escopo, respeitando as epochs das gravações pendentes.

O arranque de um cache persistente deve apresentar o conteúdo antes da revalidação e fazer uma consulta compacta em segundo plano: eventos Realtime antigos não são reentregues só porque o navegador reabriu. O orquestrador conserva a checagem pendente se a aba estiver oculta e usa o backoff diário de falhas para impedir um loop com TTL antigo. RAM já carregada evita reler/ressanitizar todo o IndexedDB em cada evento.

## Realtime e isolamento

O evento continua pequeno: domínio, revisão e UUID do snapshot. Não há assinatura de inserts/updates/deletes de todos os títulos. Evento sem domínio válido não invalida todos os catálogos. A confirmação ou mudança de Filmes não troca o estado de Séries/TV, biblioteca pessoal, seleção do player ou tarefa de EPG.

Hints duplicados pendentes, em voo, confirmados ou já esgotados não reiniciam o orçamento de tentativas. Hints anteriores são ignorados; UUIDs diferentes no mesmo timestamp continuam distinguíveis. Retries de 1/5/30 segundos atravessam o cooldown de 30 segundos da falha do cabeçalho; terminam após três tentativas extras. Uma nova publicação pode abrir um novo orçamento. Aba oculta adia a leitura até `resume`, preservando os hints pendentes.

Chaves persistentes continuam em projeto/provedor/partição/domínio/modo adulto. A geração da conta e do pedido impede resultado atrasado de modificar a sessão nova. Dados privados ficam nos stores e RPCs próprios. A confirmação do cabeçalho não substitui validação de acesso, RLS ou regras do servidor.

## Deltas e limites

Não foi criado protocolo de delta de títulos nesta etapa. O contrato atual publica gerações imutáveis; não fornece cursor de mudanças com continuidade, remoções explícitas e retenção de tombstones. Aplicar apenas upserts inferidos perderia exclusões ou publicações concorrentes. A otimização proporcional é nenhuma transferência completa quando a versão é igual e substituição completa/atômica quando muda.

Deltas futuros exigem contrato remoto específico de versão-base/alvo, inserts/updates/deletes, paginação consistente e recuperação por snapshot quando faltar continuidade. Não foram criadas tabelas, triggers de massa, nova fila ou regras de negócio no navegador para antecipar esse contrato.

Checagens desta frente: sintaxe Node dos módulos alterados, leitura estática de chamadores/guardas/DTO e revisão independente do protocolo cliente e do backend compacto. Não há medição de bytes, tempo de tela, RSS, saúde remota ou confirmação de deploy. A quota/evicção global de metadados IndexedDB e um novo teto geral de RAM não foram introduzidos por este protocolo.
