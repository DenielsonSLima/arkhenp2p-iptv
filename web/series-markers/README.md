# Catálogo interno de aberturas e créditos

Este diretório contém um adaptador e dados públicos separados por série:

- `index.js`: identidade, carregamento, validação, duração e política de edição.
- `registry.js`: identidades IMDb/TMDB e aliases exatos compartilhados pelo importador Node e pelo leitor no navegador; cadastrar aqui uma série evita whitelists duplicadas.
- `reader.js`: usa o manifest do Supabase quando disponível, com fallback local em até um segundo de espera pela nuvem; mantém os mesmos guards do catálogo.
- `game-of-thrones/manifest.json`: referências de Game of Thrones.
- `the-rings-of-power/manifest.json`: referências de Os Anéis de Poder.

Os manifests identificam temporada e episódio numericamente. Não há regra de “uma duração de abertura para a temporada inteira”, nem tempos copiados entre episódios. Ausência de um registro significa ausência de dados; nunca gera um horário presumido.

## Contrato do adaptador

```js
const catalog = new EpisodeMarkerCatalog();
const result = await catalog.lookup({
  item, episode, duration: video.duration,
  editionId, sourceFingerprint, // vínculo da edição/fonte previamente verificada
  allowReferenceMarkers: true, // permite diagnóstico, nunca habilita saltos
  signal: sourceController.signal
});
// Aplicar somente se isVerifiedEpisodeMarkerResult(result, context) e a fonte ainda for a mesma.
// result.markers contém openingStart, openingEnd e/ou creditsStart em segundos.
```

`item` precisa representar uma série conhecida por alias exato e candidato único, ou ID externo explícito. Ano informado deve ser consistente; homônimos como One Piece de 1999/2023 precisam de ano ou ID para desambiguação. O ID do provedor não é interpretado como IMDb/TMDB. Metadados externos conflitantes rejeitam a seleção, mesmo com um título parecido. `episode` precisa fornecer `season` e `number` (ou suas variantes explícitas `seasonNumber` / `episodeNumber`); não se adivinha episódio pelo ID ou nome nem se converte numeração de temporada em absoluta.

O resultado fornece `status`, `markers`, `series`, `mediaId`, `season`, `episode`, `dataVersion` e `provenance`. Os estados possíveis incluem `matched`, `unverified`, `edition-unverified`, `edition-mismatch`, `edition-conflict`, `invalid-data`, `unavailable` e `cancelled`. Fora de `matched`, `markers` é sempre `null`. Evidências brutas podem aparecer em `references[]`, somente para diagnóstico. Trocar de fonte deve cancelar seu `AbortController`; `reset()` invalida todo o catálogo carregado e todas as respostas pendentes.

O adaptador mantém um cache por série, compartilha requests simultâneos e limita o carregamento a quatro segundos. O cancelamento de um consumidor não cancela outro consumidor ativo. Erros não são armazenados como sucesso; respostas que chegam após cancelamento, timeout ou reset não entram no cache.

Quando a nuvem responde com uma série parcial, uma edição incompatível ou uma referência inativa, `EpisodeMarkerReader` também verifica o arquivo local daquele episódio. O fallback só fornece marcações verificadas com `matched`, com as mesmas regras de identidade, duração e prova de edição/fonte. Um registro verificado da nuvem tem prioridade e não é completado com uma janela de outra fonte. Um conflito verificado não pode ser ocultado por fallback. Cada catálogo tem seu próprio limite de quatro segundos; a espera inicial da nuvem é limitada a um segundo.

## Esquema de dados

Cada manifest tem `schemaVersion: 1`, uma `dataVersion` textual, `series` com `slug`, título e IDs externos confirmados, além de `records`. A chave lógica de cada registro é **série + temporada + episódio + edição**:

| Campo | Significado |
| --- | --- |
| `season`, `episode` | Números reais da temporada e do episódio |
| `edition.id` | Identificador da edição ou referência |
| `edition.durationSeconds` | Duração associada à referência, obrigatória para conferir o arquivo |
| `edition.toleranceSeconds` | Tolerância explícita e limitada; não é um ajuste automático dos tempos |
| `edition.sourceFingerprint` | Opcional: fingerprint opaco de 16 caracteres hexadecimais da fonte, sem URL ou token |
| `verification.status` | `community-reference`, `verified` ou `unverified` |
| `verification.blockEarlyNext` | `true` preserva conteúdo final quando prévia, pós-créditos ou limites ambíguos tornam inseguro antecipar o próximo episódio |
| `markers.openingStart`, `openingEnd`, `creditsStart` | Tempos numéricos em segundos; incluir somente os horários disponíveis |
| `sources[]` | URL HTTPS, título, data de consulta e evidências públicas disponíveis |

Também podem ser preservados metadados de confiança, quantidade de contribuições, concordância e conflitos retornados pelas fontes. Um número de confiança de uma base comunitária não comprova que o arquivo do provedor tem a mesma edição. Duas bases podem compartilhar contribuições; duas URLs não provam independência.

`verification.openingCandidates` pode preservar intervalos publicados para auditoria. O cliente não calcula interseção, média, deslocamento ou ampliação a partir deles. O antigo resultado `community-overlap` foi desativado: concordância entre contribuições não comprova a edição do vídeo.

Em Game of Thrones T5 E1, as fontes publicam 0–118,7s, 0–115,8s e 6–113s. Esses registros permanecem como referências independentes; o trecho comum não é uma janela executável no player. O manifest aberto preserva os intervalos SkipDB e suas durações originais; a referência IntroDB mantém sua própria fonte.

Um registro verificado com `blockEarlyNext: true` pode ter `markers: {}` e continuar elegível, desde que identificação, duração e vínculo de edição/fonte sejam satisfeitos. Seu resultado `matched` contém `blockEarlyNext: true`; isso é uma política de preservação, sem afirmar a existência de abertura ou créditos. O player bloqueia a antecipação configurada e aguarda `ended`, salvo marcação manual explícita de créditos. Sem essa flag, um objeto vazio não fornece marcações ativas. O padrão novo `markers` já aguarda `ended` quando não há créditos verificados/manuais; offsets previamente salvos são preservados.

## Política de verificação e limites

Referências comunitárias ficam inativas para execução independentemente de `allowReferenceMarkers`, da duração ou da quantidade de fontes concordantes. A opção apenas permite retornar evidência bruta em `references[]`. Não existe botão de pulo baseado somente nessa evidência, nem convite automático para o usuário calibrar cada episódio.

O fim de créditos publicado pela fonte pode anteceder cenas adicionais e não deve ser inferido como duração final do arquivo. Duração semelhante não prova cortes, recapitulações ou logotipos idênticos. Não há reconhecimento visual ou acústico de abertura neste resolvedor. Nenhum tempo é escalado para fazer uma edição diferente caber.

A política `verified` é a única executável: além da fonte documentada e duração com tolerância máxima de dois segundos, exige `editionId` explícito coincidente ou `sourceFingerprint` coincidente. Uma edição explicitamente diferente sempre é rejeitada. Registros verificados divergentes para o mesmo vínculo retornam `edition-conflict`. O player repete as guardas antes de agir. As marcações manuais por conta/fonte continuam sendo outro módulo e têm prioridade na integração.

Se uma edição comprovada e uma referência comunitária forem ambas compatíveis, a edição comprovada tem prioridade. O adaptador Supabase pode preservar um fingerprint explícito em `provenance.edition.sourceFingerprint`; a string formada pelos IDs do provedor e container no player não comprova a edição do arquivo e não é convertida em verificação. Sem prova real fornecida ao resolvedor, `verified` permanece inativo.

## Troca futura por banco

O player depende apenas de `lookup(context)` e do formato do resultado. Um futuro adaptador de banco pode substituir o carregamento dos manifests mantendo identidade, versão, proveniência e regras de edição. Não coloque consultas de banco nem tokens nos JSONs públicos. O schema deve continuar versionado; versões desconhecidas são rejeitadas.

Execute `node --test tests/series-marker-catalog.test.mjs` para conferir identidade, políticas de edição, cancelamento, cache, timeout e descarte de respostas antigas. Os testes usam registros sintéticos isolados dos manifests públicos.

## Cobertura pesquisada e seed

A pesquisa inicial de 15/10/2026 encontrou 73 registros de Game of Thrones: 21 referências concordantes e 52 com conflitos entre bases. Em Os Anéis de Poder, havia 16 registros: sete referências concordantes e nove inativas, incluindo seis sem runtime público. Nenhum desses totais certifica a edição WPLAY ou autoriza execução automática. A auditoria posterior está em [relatório de fontes](../../reports/marker-source-audit-2026-10-15.md).

`tools/prepare-series-marker-data.mjs` normaliza o arquivo de respostas pesquisadas dos Anéis de Poder e gera `supabase/seed-series-markers.sql` para os dois manifests. O seed contém 83 linhas com duração e limites válidos: 28 `community-reference` e 55 `unverified`. As seis referências sem runtime ficam documentadas no manifest local e não são inseridas com uma duração fictícia no banco. O seed preserva URLs públicas, datas, evidências e motivos dos conflitos.
