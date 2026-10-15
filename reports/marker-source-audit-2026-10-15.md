# Auditoria de fontes de marcações — 15/10/2026

Auditoria de leitura pública, sem credenciais, submissões ou alterações no banco. Foram conferidos o inventário integral de cada obra abaixo, todos os segmentos correspondentes no dump SkipDB e amostras dirigidas da IntroDB. Encontrar um intervalo comunitário não verifica a edição WPLAY. A diferença relatada de **1:57 para 3:18 não foi transformada em deslocamento de 81 segundos**.

O dump disponível foi gerado em `2026-10-15T10:00:56.882Z`, obtido anteriormente às `11:25:21.704Z`, com 106.711 segmentos de todas as obras. Os inventários e as amostras foram consultados novamente durante esta auditoria; os horários de coleta estão nos JSONs anexos. Cobertura e respostas podem mudar após esses horários.

## Identidades que precisam permanecer separadas

| Obra | Ano inicial | IMDb | TMDB | Tipo |
| --- | ---: | --- | ---: | --- |
| Game of Thrones | 2011 | tt0944947 | 1399 | Série |
| Vikings | 2013 | tt2306299 | 44217 | Série |
| Vikings: Valhalla | 2022 | tt11311302 | 116135 | Série distinta |
| One Piece | 1999 | tt0388629 | 37854 | Anime |
| ONE PIECE | 2023 | tt11737520 | 111110 | Adaptação com atores |
| The Lord of the Rings: The Rings of Power | 2022 | tt7631058 | 84773 | Série |
| The Fellowship of the Ring | 2001 | tt0120737 | 120 | Filme |
| The Two Towers | 2002 | tt0167261 | 121 | Filme |
| The Return of the King | 2003 | tt0167260 | 122 | Filme |

Os cruzamentos IMDb/TMDB/ano dos seis últimos títulos foram confirmados pela [consulta pública por IMDb do SkipDB](https://skipdb.tv/api/titles/search?q=tt0388629), preservada em `marker-source-audit-2026-10-15-identities.json`. [Vikings](https://www.imdb.com/title/tt2306299/), [Valhalla](https://www.imdb.com/title/tt11311302/), [One Piece anime](https://www.imdb.com/title/tt0388629/) e [One Piece com atores](https://www.imdb.com/title/tt11737520/) também têm páginas IMDb distintas.

A [busca pública por Vikings](https://skipdb.tv/api/titles/search?q=Vikings) também devolve o documentário **Vikings (2012), TMDB 61856**, além de filmes e outras séries. O nome sozinho não identifica a obra. A [HISTORY descreve a série de Ragnar](https://www.history.com/shows/vikings), enquanto a [Netflix identifica Valhalla como uma continuação ambientada mais de cem anos depois](https://about.netflix.com/en/news/vikings-valhalla-new-characters-new-battles). Rótulos do provedor como `LEG`, qualidade e idioma distinguem uma oferta; não autorizam trocar o IMDb nem ignorar conflito de ano.

## Cobertura pública constatada

| Obra | Inventário público atual | Dump: episódios com algum segmento | Dump: episódios com abertura positiva |
| --- | --- | ---: | ---: |
| Game of Thrones | 73 regulares + 301 especiais | 73 regulares + 29 especiais | 73 regulares + 9 especiais |
| Vikings (2013) | 89, temporadas 1–6 | 89 | 89 |
| Valhalla (2022) | 24, temporadas 1–3 | 24 | 21 |
| One Piece (1999) | 1.169, agrupados em 23 temporadas | 0 | 0 |
| ONE PIECE (2023) | 17, incluindo uma entrada de T3 | 0 | 0 |
| Os Anéis de Poder | 24, incluindo oito entradas de T3 | 16, T1/T2 | 12 |
| Trilogia de filmes | Uma obra por IMDb | Um segmento de créditos por filme | 0 |

Esses números são da fonte, não uma contagem de arquivos disponíveis na WPLAY ou de marcações verificadas. A [API de inventário](https://skipdb.tv/api/titles/tt0944947) inclui especiais e entradas anunciadas; não tratar todo o inventário como conteúdo reproduzível. O CSV anexo enumera **todos os 162 episódios regulares de GoT/Vikings** e quantas variantes de abertura, créditos e duração cada um possui. O dump preserva todas as variantes encontradas, sem escolher uma por aproximação. São 46 episódios de GoT com múltiplas variantes de abertura considerando também especiais.

As amostras IntroDB confirmam referências para o primeiro episódio dos dois One Piece; não houve varredura cega de mais de mil episódios. A cobertura restante da IntroDB permanece **não auditada**, para consulta incremental de lacunas após identificação dos episódios WPLAY. HTTP 200 com todos os segmentos nulos foi contado como ausência de referência, não como sucesso de marcação.

## Discrepâncias reproduzíveis

Tempos abaixo em segundos, no arquivo da fonte; a duração é explícita apenas quando consta do segmento SkipDB.

| Obra/episódio | SkipDB: abertura; duração | IntroDB: abertura | Consequência |
| --- | --- | --- | --- |
| GoT T1E1 | 447,8–461,4; 3699,2 | 437–531 | Finais divergem 69,6s; proximidade da duração não seleciona a abertura correta. |
| GoT T5E1 | 0–115,8; 3132,4 **ou** 0–118,7; 3131,6 | 6–113 | Duas edições com durações separadas por 0,8s e intervalos diferentes. |
| Vikings T1E1 | 204,2–254,5; 2797 | 10–30 | Contradição forte; não resolver com interseção ou prioridade fixa. |
| Vikings T1E2 | 0–46,2; 2830,2 | 10–30 | Não existe um deslocamento constante dedutível a partir de T1E1. |
| One Piece anime T1E1 | Ausente no dump | 28,783–118,783 | Referência sem confirmação da edição WPLAY. |
| ONE PIECE atores T1E1 | Ausente no dump | 29–119 | Outro IMDb; intervalo parecido não permite compartilhar a marcação. |

Respostas preservadas no JSON de amostras; consultas diretas: [GoT T1E1 IntroDB](https://api.introdb.app/segments?imdb_id=tt0944947&season=1&episode=1), [GoT T5E1 IntroDB](https://api.introdb.app/segments?imdb_id=tt0944947&season=5&episode=1), [GoT T5E1 SkipDB](https://api.skipdb.tv/api/segments?imdb_id=tt0944947&season=5&episode=1&duration=3129&adjust=none), [Vikings T1E1 SkipDB](https://api.skipdb.tv/api/segments?imdb_id=tt2306299&season=1&episode=1&adjust=none), [Vikings T1E1 IntroDB](https://api.introdb.app/segments?imdb_id=tt2306299&season=1&episode=1), [Vikings T1E2 IntroDB](https://api.introdb.app/segments?imdb_id=tt2306299&season=1&episode=2).

As durações decodificadas pela equipe no acesso autorizado WPLAY foram 3697,319s para GoT T1E1, 3129,669s para GoT T5E1 e 2651,191s para Vikings T1E1. São observações do vídeo, não provas públicas nem verificação visual dos limites. GoT T1E1 fica somente 1,881s distante de uma duração SkipDB apesar da grande divergência dos intervalos. Vikings T1E1 difere 145,809s da referência SkipDB: o arquivo precisa de sua própria verificação, sem aplicar essa diferença aos tempos.

**Observação audiovisual posterior, limitada:** no GoT T5E1 de 3129,668208s decodificado pelo Chrome, a equipe encontrou crédito de direção em fundo escuro aos 113s e a primeira cena já iniciada aos 117s. Isso delimita a transição em **113–117s**, sem certificar um final exato. O usuário não identificou o episódio em que observou 3:18; essa observação não foi atribuída a T5E1. Buscas posteriores do vídeo receberam HTTP 429 e foram suspensas; não há confirmação dos quadros de 198/205s. Consulte a [conferência das ofertas WPLAY](wplay-marker-edition-audit-2026-10-15.md). Nenhuma referência foi promovida a `verified` por esses quadros.

Os três filmes retornaram todos os campos nulos na IntroDB usando `is_movie=true`. No dump SkipDB há somente créditos: Sociedade do Anel 12802,2–13698,4s; Duas Torres 13234,5–14132,1s; Retorno do Rei 5657,6–5881,2s. O último totaliza **98min01,2s**, um candidato que exige investigar arquivo dividido, identificação errada ou fonte incorreta; nenhuma dessas hipóteses foi comprovada. Não publicar esses créditos como compatíveis com qualquer edição do filme.

## Terceira base independente consultada

Às 18:41 UTC, TheIntroDB respondeu HTTP200 usando as durações MP4 efetivamente medidas. As três respostas sanitizadas estão em `marker-source-audit-2026-10-15-third-source.json`:

| Consulta | Abertura retornada | Créditos retornados |
| --- | --- | --- |
| GoT T5E1, 3.129,669 s | início ausente; fim 113 s | 3.047,7–3.131,6 s |
| GoT T1E1, 3.697,319 s | 435,691–534,851 s | início 3.630,687 s; fim ausente |
| Vikings T1E1, 2.651,191 s | 205,5–254,25 s | início 2.627 s; fim ausente |

Vikings apresenta duas referências próximas em SkipDB/TheIntroDB e uma bastante diferente em IntroDB.app. GoT T1E1 também mantém a contradição com a abertura curta do SkipDB. Esses cruzamentos ajudam a localizar candidatos para inspeção, mas a aceitação de `duration_ms` não comprova que a base verificou a montagem WPLAY. Em GoT T5E1, o fim de créditos retornado excede a duração real; permanece não executável. Campos nulos não foram completados com estimativas.

Consultas públicas: [GoT T5E1](https://api.theintrodb.org/v3/media?imdb_id=tt0944947&season=5&episode=1&duration_ms=3129669), [GoT T1E1](https://api.theintrodb.org/v3/media?imdb_id=tt0944947&season=1&episode=1&duration_ms=3697319), [Vikings T1E1](https://api.theintrodb.org/v3/media?imdb_id=tt2306299&season=1&episode=1&duration_ms=2651191).

## Numeração de One Piece

O [inventário do anime](https://skipdb.tv/api/titles/tt0388629) mantém números absolutos: T1E1–61, T2E62–77, T3E78–91. A IntroDB devolveu resultados diferentes para [T2E62](https://api.introdb.app/segments?imdb_id=tt0388629&season=2&episode=62), abertura 0–106s, e [T2E1](https://api.introdb.app/segments?imdb_id=tt0388629&season=2&episode=1), abertura 28,783–118,783s; [T1E62](https://api.introdb.app/segments?imdb_id=tt0388629&season=1&episode=62) veio sem segmentos. Ambos os esquemas têm registros: não renumerar por posição nem aceitar uma resposta existente como prova de identidade do episódio. Conferir título, número absoluto, temporada e identificador nativo antes de consultar/certificar a edição.

## Contratos das APIs e código observado

SkipDB separa `intro`, `recap`, `outro` e `preview`, aceita duração em segundos e oferece `adjust=none`. O dump guarda variantes por duração; a consulta normal entrega um vencedor por tipo. A documentação descreve `exact` como diferença de até dois segundos, mas a amostra de GoT T5E1 retornou `exact`, `adjusted=false` e `offset_ms=-3400`. Isso é explicado pelo [código oficial de ajuste](https://raw.githubusercontent.com/SkipDB-TV/skipdb/main/src/lib/duration.ts): com `adjust=none`, diferenças dentro da janela de deslocamento também recebem `exact`. A [rota oficial](https://raw.githubusercontent.com/SkipDB-TV/skipdb/main/src/app/api/segments/route.ts) arredonda a duração recebida para segundos inteiros. Portanto `exact` não comprova igualdade de duração ou de edição. [Documentação SkipDB](https://skipdb.tv/docs).

A [especificação OpenAPI IntroDB](https://api.introdb.app/openapi.json) recebe IMDb/temporada/episódio ou `is_movie=true`, retorna segmentos agregados e não oferece parâmetro de edição ou duração. `outro.end_ms` não é duração do arquivo, especialmente quando pode existir cena posterior. `confidence=1` e `submission_count` descrevem a referência comunitária; não certificam o arquivo WPLAY.

Estado local lido **antes das correções desta rodada**:

- `registry.js` tinha GoT/Rings e outros títulos conhecidos, mas não Vikings/One Piece. O fallback de identidade vindo do Supabase permite registros dinâmicos; exige vínculo de catálogo correto.
- `providers.mjs` consulta SkipDB com `adjust=none`, sem duração. `pipeline.mjs` usa IntroDB quando falha/falta abertura primária; uma abertura presente encerra o fallback, mesmo quando não há prova da edição.
- `metadata.mjs` mantém respostas sem duração como `unverified`, corretamente; o importador de dump conserva durações, variantes, origem e licença.
- `index.js` podia transformar `community-reference` em `matched` somente com runtime próximo e habilitação de referências. Também projetava `referenceOpening` de evidência sem runtime. `reader.js` podia combinar interseções de fontes (`community-overlap`). Esses caminhos não demonstram o limite correto na WPLAY, mesmo quando evitam deslocamento automático.

## Verificação da edição a executar

1. Usar o catálogo autorizado para relacionar obra, episódio e oferta WPLAY; separar dublado/legendado e arquivos distintos.
2. Associar a referência ao arquivo usando identidade estável sem URL assinada, credencial ou conta pessoal na chave global. Conferir duração decodificada e limites visuais/sonoros no próprio arquivo.
3. Verificar início e fim da abertura; tratar recap, prévia, créditos e cena pós-créditos como segmentos independentes. Só um intervalo conferido para essa edição pode operar o salto automático.
4. Preservar referências contraditórias como diagnóstico, sem interseção, duração estimada ou ajuste fixo. Falha de correspondência deve permanecer explícita e não virar edição verificada.
5. Compartilhar globalmente a evidência de edição confirmada, mantendo sessão e progresso privados. A fila pode reaproveitar o corpus integral auditado; One Piece exige resolver numeração antes da expansão.

## Evidências locais

- `marker-source-audit-2026-10-15-identities.json`: seis cruzamentos atuais IMDb/TMDB/ano/tipo.
- `marker-source-audit-2026-10-15-inventories.json`: nove inventários públicos, sem sinopses, imagens ou dados de conta.
- `marker-source-audit-2026-10-15-dump.json`: segmentos/variantes das nove obras e contagens, sem identificadores de colaboradores.
- `marker-source-audit-2026-10-15-samples.json`: respostas HTTP e URLs públicas das amostras.
- `marker-source-audit-2026-10-15-third-source.json`: três consultas independentes TheIntroDB com as durações WPLAY medidas, preservando campos ausentes.
- `marker-source-audit-2026-10-15-episodes.csv`: 73 episódios regulares GoT + 89 Vikings, todos ainda classificados como referências que requerem verificação de edição nesta auditoria.

Dados derivados do SkipDB preservam [ODbL 1.0 e Service Provider Reciprocity](https://skipdb.tv/license). O relatório não concede licenças adicionais nem modifica a fonte original.
