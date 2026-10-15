# Verificação de marcações antes da reprodução

Atualizado em 15/10/2026. Este documento descreve a proteção do cliente. A comparação pública de identidades, inventários e intervalos está no [relatório de fontes](../reports/marker-source-audit-2026-10-15.md). Encontrar um intervalo nas bases não significa que ele foi conferido no arquivo WPLAY.

## Problema corrigido

O leitor anterior aceitava registros `community-reference` pela semelhança de duração e existência de uma fonte. O aplicativo habilitava essa opção. O player então tratava esses tempos como uma abertura válida e iniciava a contagem automática. Havia ainda uma alternativa `referenceOpening` extraída de evidência bruta sem vínculo de edição e uma interseção entre fontes que produzia uma terceira janela.

Essas condições não provam correspondência temporal: dois arquivos podem ter duração quase igual e cenas iniciais diferentes. `exact` no [contrato SkipDB](https://skipdb.tv/docs) descreve comparação de runtime; a [consulta IntroDB](https://introdb.app/docs/api) é identificada por IMDb, temporada e episódio, sem vincular a edição WPLAY. A diferença relatada entre 1:57 e 3:18 não foi transformada em um deslocamento fixo nem aplicada a outros episódios.

## Contrato executável

`EpisodeMarkerCatalog` só retorna `status: matched` quando o registro tem `verification.status: verified`, fonte HTTPS documentada, temporada e episódio exatos, duração decodificada compatível e vínculo explícito com `editionId` ou fingerprint de origem previamente verificado. Uma tolerância de até dois segundos é uma validação adicional, nunca a prova principal.

O resultado inclui `mediaId`, temporada, episódio e proveniência com duração, tolerância, edição e fingerprint quando existente. `EpisodeSkipController` repete essa verificação antes de aceitar qualquer janela. Respostas de adaptadores com somente `marks`, `matched` sem prova, confiança comunitária, série ou episódio diferentes permanecem inativas. O identificador lógico atual do player não é convertido em fingerprint para simular uma verificação do arquivo.

Registros verificados divergentes para o mesmo vínculo retornam `edition-conflict`, sem marcações executáveis. O leitor não oculta esse conflito recorrendo a um arquivo local mais antigo. Um registro verificado da nuvem tem prioridade; na ausência dele, os adaptadores locais passam pelas mesmas regras. Os intervalos de fontes distintas não são combinados, deslocados, promediados ou intersectados.

Referências comunitárias podem permanecer em `references[]` para diagnóstico. Não habilitam botão de pulo, contagem de abertura ou avanço antecipado. `allowReferenceMarkers` controla apenas a disponibilidade desse diagnóstico legado, sem alterar a exigência de verificação.

## Identidade da obra

O resolvedor usa candidatos únicos e confere IMDb, TMDB e ano informado no título ou no catálogo. Nomes homônimos, como One Piece de 1999 e de 2023, exigem ano ou identidade explícita consistente. Não depende da ordem do cadastro. Sufixos de idioma e qualidade não substituem o ano ou o IMDb. Vikings e Vikings: Valhalla têm identidades separadas.

A numeração de temporada/episódio não é convertida em numeração absoluta. Por exemplo, T2E1 não passa a episódio 62 sem uma correspondência validada da edição do provedor.

## Comportamento do player

O padrão de reprodução passa a `nextMode: markers`: créditos verificados ou marcados explicitamente pelo usuário podem antecipar o próximo episódio; sem eles, a contagem só começa após o evento real de fim do vídeo. Atingir numericamente a duração não basta. O usuário mantém cinco segundos para cancelar. Preferências `offset` já salvas continuam respeitadas, pois o armazenamento anterior não distingue o antigo padrão de uma escolha explícita.

Marcações manuais continuam disponíveis nos ajustes avançados e são isoladas por conta, série, episódio, origem e duração. O aviso automático que convidava todo usuário a marcar a abertura sobre o vídeo foi retirado. Ausência de dados não inicia uma nova etapa de calibração para assistir.

Cancelamento, pausa, buffering, troca de origem, episódio e conta continuam revogando trabalhos antigos. Marcações externas nunca são persistidas como marcação manual.

## Validação e limites

Testes focados executam o catálogo, o leitor, o controller real com vídeo/relógio simulados e a interface de preferências. Cobrem os arquivos comunitários reais de GoT T5E1, referências brutas sem duração, conflitos verificados, identidade por ano/IMDb/TMDB, resultados assíncronos atrasados, isolamento de conta, marcações manuais e avanço seguro até `ended`.

Comando: `node --test tests/series-marker-catalog.test.mjs tests/series-marker-reader.test.mjs tests/episode-skip.test.mjs tests/series-playback.test.mjs tests/series-playback-preferences-view.test.mjs`.

Os testes de execução usam edições sintéticas explicitamente verificadas para provar o comportamento da guarda. Não certificam intervalos de vídeos WPLAY. A medição e a inspeção da mídia real são uma etapa separada; nenhum novo intervalo real foi declarado verificado por este patch.

A fixture privada `.local/verify-marker-guard-browser.mjs` passou em contexto Chromium isolado com `ImmersivePlayer`, `EpisodeMarkerReader` e manifests GoT T5E1 reais, mas vídeo, relógio e resposta de detalhes simulados. Com duração 3129,669s, nenhuma referência comunitária mostrou botão/contagem de pulo; detalhes carregados sob demanda disponibilizaram o próximo episódio e o clique real funcionou. Créditos comunitários, os últimos 30 segundos e atingir numericamente a duração não anteciparam o próximo. Somente `ended` iniciou a contagem de cinco segundos, sem duplicação. Marcações locais de teste, feitas por cliques nos ajustes avançados, continuaram executando o seek central. Zero exceções JavaScript e zero `console.error`.

Evidências privadas: `.local/marker-guard-browser-evidence.json` e capturas `marker-guard-community-browser.png`, `marker-guard-ended-browser.png`, `marker-guard-manual-browser.png`, todas identificadas como vídeo simulado. O contexto temporário foi descartado ao concluir.
