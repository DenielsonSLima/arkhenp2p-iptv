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
  allowReferenceMarkers: true, // somente no teste autorizado das séries cadastradas
  signal: sourceController.signal
});
// Aplicar somente se result.status === 'matched' e a fonte ainda for a mesma.
// result.markers contém openingStart, openingEnd e/ou creditsStart em segundos.
```

`item` precisa representar uma série conhecida por alias exato ou ID externo explícito. O ID do provedor não é interpretado como IMDb/TMDB. Metadados externos conflitantes rejeitam a seleção, mesmo com um título parecido. `episode` precisa fornecer `season` e `number` (ou suas variantes explícitas `seasonNumber` / `episodeNumber`); não se adivinha episódio pelo ID ou nome.

O resultado fornece `status`, `markers`, `series`, `season`, `episode`, `dataVersion` e `provenance`. Os estados possíveis incluem `matched`, `unverified`, `edition-unverified`, `edition-mismatch`, `invalid-data`, `unavailable` e `cancelled`. Fora de `matched`, `markers` é sempre `null`. Trocar de fonte deve cancelar seu `AbortController`; `reset()` invalida todo o catálogo carregado e todas as respostas pendentes.

O adaptador mantém um cache por série, compartilha requests simultâneos e limita o carregamento a quatro segundos. O cancelamento de um consumidor não cancela outro consumidor ativo. Erros não são armazenados como sucesso; respostas que chegam após cancelamento, timeout ou reset não entram no cache.

Quando a nuvem responde com uma série parcial, uma edição incompatível ou uma referência inativa, `EpisodeMarkerReader` também verifica o arquivo local daquele episódio. O fallback só substitui o resultado se conseguir `matched`, com as mesmas regras de identidade, duração e proveniência. Um resultado válido da nuvem não precisa carregar outro arquivo local. Cada catálogo tem seu próprio limite de quatro segundos; a espera inicial da nuvem é limitada a um segundo.

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

Um registro com `blockEarlyNext: true` pode ter `markers: {}` e continuar elegível, desde que os mesmos guards de identificação, duração e fonte sejam satisfeitos. Seu resultado `matched` contém `blockEarlyNext: true`; isso é uma política de preservação, sem afirmar a existência de uma abertura ou créditos. O player bloqueia a antecipação automática aproximada de 30 segundos e aguarda `ended`, salvo se houver uma marcação de créditos manual explícita. Sem essa flag, um objeto vazio não fornece marcações ativas.

## Política do teste e limites

O padrão `allowReferenceMarkers: false` mantém as referências comunitárias inativas. O teste autorizado usa `true` somente para as séries explicitamente cadastradas. Para ativá-las, é obrigatório haver identificação IMDb conhecida, fonte pública HTTPS, janela válida e duração do vídeo dentro da tolerância informada, com máximo de **três segundos**. O resultado é identificado como `confidence: 'community-reference'` e deve ser exibido no player como referência em teste. Registros com fontes conflitantes e `verification.status: 'unverified'` continuam inativos.

A duração pública pode ser derivada do fim dos créditos indicado pela fonte. Isso é uma referência de runtime, não uma medição do arquivo do provedor. Duração semelhante reduz erros de versão, mas não prova cortes, recapitulações ou logotipos idênticos. Não há reconhecimento visual ou acústico de abertura. Nenhum tempo é escalado para fazer uma edição diferente caber.

A política `verified` é mais estrita: além da fonte pública e duração com tolerância máxima de dois segundos, exige `editionId` explícito coincidente ou `sourceFingerprint` coincidente. Uma edição explicitamente diferente sempre é rejeitada, inclusive no modo de teste comunitário. As marcações manuais por conta/fonte continuam sendo outro módulo e podem ter prioridade na integração.

Se uma edição comprovada e uma referência comunitária forem ambas compatíveis, a edição comprovada tem prioridade. O adaptador Supabase pode preservar um fingerprint explícito em `provenance.edition.sourceFingerprint`; a string formada pelos IDs do provedor e container no player não comprova a edição do arquivo e não é convertida em verificação. Sem prova real fornecida ao resolvedor, `verified` permanece inativo.

## Troca futura por banco

O player depende apenas de `lookup(context)` e do formato do resultado. Um futuro adaptador de banco pode substituir o carregamento dos manifests mantendo identidade, versão, proveniência e regras de edição. Não coloque consultas de banco nem tokens nos JSONs públicos. O schema deve continuar versionado; versões desconhecidas são rejeitadas.

Execute `node --test tests/series-marker-catalog.test.mjs` para conferir identidade, políticas de edição, cancelamento, cache, timeout e descarte de respostas antigas. Os testes usam registros sintéticos isolados dos manifests públicos.

## Cobertura pesquisada e seed

A pesquisa de 15/10/2026 encontrou 73 registros de Game of Thrones: 21 concordantes para o teste e 52 com conflitos entre bases. Em Os Anéis de Poder, há 16 registros: sete elegíveis ao teste e nove inativos, incluindo seis sem runtime público que permita conferir a edição. Nenhum runtime foi preenchido por aproximação.

`tools/prepare-series-marker-data.mjs` normaliza o arquivo de respostas pesquisadas dos Anéis de Poder e gera `supabase/seed-series-markers.sql` para os dois manifests. O seed contém 83 linhas com duração e limites válidos: 28 `community-reference` e 55 `unverified`. As seis referências sem runtime ficam documentadas no manifest local e não são inseridas com uma duração fictícia no banco. O seed preserva URLs públicas, datas, evidências e motivos dos conflitos.
