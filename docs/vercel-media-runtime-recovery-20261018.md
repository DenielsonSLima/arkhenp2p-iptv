# Recuperação da sessão e transporte na Vercel

Data: 18/10/2026, BRT. Este registro distingue código, testes sintéticos, inspeção de infraestrutura e observações do usuário. Não certifica estabilidade audiovisual da nova versão.

## Comparação e reunião técnica

O usuário confirmou abertura rápida no localhost e no IPTV Player do iPhone, mas mostrou falhas intermitentes e buffering na Vercel. A observação do espelhamento mostrou quadros distintos em reprodução; a abertura abaixo de cinco segundos foi informada pelo usuário, sem cronômetro automatizado. Após sua solicitação, o espelhamento, o APK e os testes com conta foram interrompidos. As frentes seguintes usaram código, fixtures e leituras de infraestrutura sem conta WPLAY.

Quatro frentes confrontaram as evidências:

| Frente | Conclusão e decisão |
| --- | --- |
| Sessão distribuída | Corrigir a associação entre cipher e epoch após falha de checkpoint; manter fencing, STOP e a revogação de leitores. |
| Renovação cloud | JWT vencido não pode entrar em leitura que proíbe renovação; a recuperação precisa de writer e persistência, incluindo revisão de catálogo. |
| APK e pipeline do player | O fluxo nativo tem transporte e callbacks próprios. HLS.js 1.6.13 tem um bug público de agendamento, mas esse achado não explica sozinho os 503 e não foi misturado a este lote. |
| Infraestrutura Vercel | Deploy, projeto, alias e variável de produção estavam corretos. Sem evidência para mudar região, duração ou Fluid. |

A Vercel usa `RuntimeSessionStore`; o localhost usa sessão em RAM. Portanto, comportamento local correto não valida a camada distribuída exclusiva da produção. Nas capturas, os 503 também atingiam guia, imagens e detalhes, antes de se discutir codec ou buffer.

## Evidência de infraestrutura

O deploy `dpl_DwfMPiVnw8xLTSuh3qaQaEAn5nKB`, commit `71717fd2dece930db0abc25b374d85e5583eb61d`, estava READY no projeto autorizado e com alias correto, Node 24, Fluid ativo e região `iad1`. `ARKHEN_SUPABASE_CONFIG` estava presente como variável sensível de produção. Seu valor não foi exposto nem alterado nesta investigação.

A saúde oficial de Database, Auth e REST retornou `ACTIVE_HEALTHY`. Duas RPCs com hashes aleatórios inexistentes, usando apenas a configuração server-side local, responderam como esperado: leitura ausente em 328 ms e validação negativa em 227 ms. Isso não mede a configuração privada nem o trajeto interno da Vercel. Uma requisição anônima ao `/api/session` online respondeu 200/`SESSION_REQUIRED` em aproximadamente 2 s, sem conta, cookie existente ou mídia.

Uma consulta limitada de agregados encontrou cipher máximo de 973.363 bytes e média de 385.962 bytes, sem retornar identificadores ou payloads. O desenho anterior buscava esse estado inteiro em cada segmento. Isso identifica uma transferência adicional concreta; não estabelece sua participação percentual em cada travamento.

Nenhum log Supabase foi consultado. Uma consulta Vercel de 90 segundos foi rejeitada pela revisão automática por não seguir o intervalo de 5–15 minutos indicado nas instruções; ela não foi executada nem repetida por outro caminho. A investigação prosseguiu por saúde, respostas e fixtures.

## Correções implementadas

### Coerência do checkpoint

Uma falha de serialização/tamanho podia deixar o cipher anterior no banco, mas liberar o writer com o epoch do estado novo. A próxima leitura rejeitava esse par incoerente. O store agora conserva o último epoch durável e só o avança após commit aceito, junto ao snapshot correspondente. Se a restauração falhar e o epoch não vier na aquisição, a liberação exige uma leitura que confirme o mesmo cipher; não inventa estado anônimo.

A correção impede novos pares inconsistentes nesse caminho. Não recupera automaticamente ciphertext corrompido, chave antiga ou registros já incoerentes.

### Renovação do JWT cloud

Metadados cloud só podem ser leitores diretos com token presente e expiração além da margem de 60 segundos. Sessão vencida, legada ou malformada usa writer para renovar e persistir. A rota de revisão passa pelo mesmo attach quando está nesse caminho. Segmentos, status e imagens locais continuam independentes dessa renovação. Conta desativada continua recusada.

### Cache privado e curto para fragmentos

`RuntimeSessionSnapshotCache` conserva somente cipher e epoch no processo: até 2 segundos absolutos, 8 entradas e 8 MiB. Não é cache global de biblioteca, Storage ou frontend. Hits não renovam a validade e não compartilham objetos de cliente.

O opt-in da aplicação se restringe a GET/HEAD de assets com token válido. O store restaura um estado novo e exige que o asset seja um segmento de duração positiva pertencente à reprodução ativa. Antes de usá-lo, valida seu epoch por RPC; a validação final e a guarda durante streaming continuam. Indisponibilidade da validação falha fechada. Epoch recusado, asset ausente ou predicate inadequado exigem leitura fresca.

Commits aceitos e atualizações de backoff invalidam gerações de cache, impedindo que uma leitura antiga em voo sobrescreva estado novo no mesmo processo. Cipher inalterado não recebe uma nova vida artificial. Outro processo ainda pode ter URLs/cooldown do mesmo epoch antigos por até 2 s; mudanças de PIN/logout/STOP são verificadas remotamente. Não se remove descompressão/restauração: a economia demonstrada pelo fixture é evitar o payload completo do `read` nos hits, substituindo-o por validação pequena.

## Verificação

Fixtures cobrem serialização rejeitada, último epoch aceito, restauração incompleta, JWT vencido e renovação durável, conta desativada, PIN, logout, STOP, callbacks atrasados, cache com prazo absoluto/limites, isolamento de instâncias, falha de validação, asset novo, URL alterada e invalidação de backoff. A revisão cruzada não identificou bypass desses contratos. O lote integrado aprovou 195 testes; bundles backend/frontend e `git diff --check` também passaram.

A versão HLS e o buffer do navegador não foram modificados neste lote. O defeito público de agendamento foi documentado separadamente em [revisão do pipeline](tv-hls-upstream-pipeline-review-20261018.md). A comparação nativa está em [APK e inicialização](wplay/native-startup-comparison-20261018.md). A otimização anterior de prazo e checkpoint está em [latência](tv-playback-latency-20261018.md).

O teste real de continuidade após publicação permanece separado: não foram abertos novos canais, APK, navegador ou espelhamento para validar este lote.
