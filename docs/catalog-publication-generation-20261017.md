# Publicações de catálogo e troca de conta

Data: 17/10/2026. Evidência: inspeção e testes sintéticos locais.

Na rodada integrada, quatro testes de `SharedCatalogUpdates` falharam. Três usavam expectativas anteriores ao contrato atual: evento idêntico durante a consulta não deve agendar outra leitura; entrega duplicada após esgotar três retries não deve reiniciar um loop; o descritor normalizado contém `revision` e `snapshotId`, inclusive quando nulos. Os testes passaram a usar timestamps ISO e uma publicação realmente nova para verificar a recuperação.

A quarta falha reproduziu um defeito real: ao detectar mudança de geração em um callback agendado, o controlador retornava sem liberar `this.timer` e eventos pendentes. A conta nova podia ficar impedida de agendar sua próxima publicação. `web/sistema/catalogo/realtime.js` agora sincroniza a geração em `notify` e `resume`, limpa trabalho anterior ao detectar a mudança e confere epoch antes de permitir que callbacks antigos afetem timers novos. Resultados em voo continuam cercados por geração e epoch.

Falhas de leitura não reconhecem uma publicação nova nem apagam a última reconhecida. A repetição permanece limitada a três tentativas adicionais. Duplicatas, revisões antigas e identificadores inválidos não reiniciam a contagem. Eventos sem domínio não se espalham para TV, Filmes e Séries; este controlador não controla nem invalida EPG ou mídia.

Validação: 17 testes passaram em `shared-catalog-updates` e `catalog-player-focus`, cobrindo geração, callback antigo, revisão em voo, limite de repetição, preservação da publicação anterior e pausa durante reprodução. Não houve navegador, chamada remota ou reinício nesta verificação. O teste de timeout503 é sintético e não prova a saúde atual do Supabase.
