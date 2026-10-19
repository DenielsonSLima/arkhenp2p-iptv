# Correção de regressões do streaming distribuído

Incidente:18/10/2026, horário BRT. Revisão concluída em19/10 UTC. Estado: falhas reproduzidas com fixtures e correções preparadas; continuidade audiovisual posterior não certificada.

O usuário informou novas regressões após o deploy de `e28a3df`. Suas cinco capturas das22:27 não estavam disponíveis no caminho fornecido. Nenhum APK, navegador, espelhamento, login ou canal real foi iniciado nesta revisão. A implementação local em execução não foi reiniciada.

## Evidência remota limitada

Uma única leitura de logs Vercel do projeto ARKHEN e deploy `dpl_FhSLnH8jgrTymqT7J8c2WLbSj5kz`, entre01:25 e01:30 UTC de19/10 (22:25–22:30 BRT de18/10), retornou20 respostas503, atingindo o limite solicitado de20 resultados. Duas incluíam `RUNTIME_SESSION_BUSY`. Isso confirma contenção observada nesse intervalo; não estima o total de falhas nem prova qual operação manteve o writer ocupado. Somente contagens e códigos foram emitidos; nenhum log Supabase foi consultado.

## Falhas demonstradas e alterações

| Falha reproduzida | Correção | Limite da conclusão |
| --- | --- | --- |
| Uma resposta de segmento já concluída fazia outra validação remota. A indisponibilidade dessa RPC gerava503 depois de200 e do corpo entregue. | O store dispensa apenas essa validação posterior quando `beforeStreaming()` concluiu e o Writable terminou. Fragmento fresco passa de2 para1 validação; cache de3 para2. | A admissão, validação antes dos bytes, guard durante streaming e validação final de respostas abertas/bufferizadas permanecem. Não elimina todo acesso ao banco. |
| `req.setTimeout` mede inatividade. Uma playlist pingando bytes mantinha o writer exclusivo além dos10s, enquanto ele era renovado. | Prazo absoluto de10s somente para rede da playlist ao vivo, compartilhado por redirects, fallback e corpo. Ao vencer, aborta, responde `LIVE_PLAYLIST_TIMEOUT`/502 e libera o writer existente. | O prazo não inclui autenticação, preparação, checkpoint ou commit. A política de segmentos/VOD não foi alterada. |
| Repetir a mesma playlist atualizava timestamps dos assets, alterando o snapshot e forçando novo gzip/AES e upload do cipher inteiro. | Descritor idêntico conserva objeto/time, mantendo o toque LRU. Mudança real de URL/duração/cacheKey continua atualizando o descritor. | Uma janela nova, token upstream rotacionado ou outra alteração real continua exigindo checkpoint novo. O payload completo ainda é restaurado em uma instância fria. |

## Verificação antes e depois

Uma cópia isolada de `e28a3df`, com os novos testes e a implementação antiga, falhou nos cenários de pipeline concluído, manifesto idêntico, ciclo distribuído e playlist que pinga bytes. A fixture do último caso encerrou por seu prazo de teste: a versão antiga não terminava a operação. Após copiar apenas os três módulos corrigidos, os78 testes focados passaram.

A fixture integrada usa o handler real, `RuntimeSessionStore`, AES/gzip e providers restaurados, com RPC e upstream sintéticos. Três instâncias alternam nove polls e nove segmentos, sem upload de cipher nos polls idênticos e sem RPC após o fim dos segmentos. Janela nova grava novo cipher; STOP em outra instância recusa o cache ainda válido e não inicia novo pedido de mídia. Não é um benchmark de rede, um teste de concorrência ou uma reprodução OTT sid/gen real; esses contratos têm fixtures próprias no conjunto integrado.

As revisões cruzadas confirmaram que os patches preservam fencing, PIN, geração, cancelamento e encerramento. A verificação audiovisual no serviço continua distinta dessa prova controlada.

O conjunto integrado isolado aprovou257 testes de runtime, rotas, autenticação sintética, PIN, STOP, VOD, HLS e transporte. Uma fixture antiga de capa retornava linhas sem `media_type`/`media_id` e não entendia o filtro `in.(...)`; sua falha também foi confirmada na implementação publicada. A fixture foi alinhada ao contrato atual do SELECT, preservando a recusa da imagem adulta. Bundles ESM de backend/frontend e checagens de sintaxe/diff passaram. Não foram modificados schema, configuração remota, buffer, qualidade ou engine do navegador.

Contexto anterior: [sessão distribuída e JWT](vercel-media-runtime-recovery-20261018.md), [latência de playlists](tv-playback-latency-20261018.md).
