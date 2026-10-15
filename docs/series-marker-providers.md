# Fontes de marcações de séries

Pesquisa conferida em 15/10/2026 por documentação oficial e consultas HTTP públicas, sem reproduzir vídeos ou enviar dados de usuários. `web/series-markers/registry.js` reúne as identidades aceitas pelo player e pelo importador. IDs WPLAY não substituem IMDb/TMDB; temporada e episódio continuam obrigatórios.

## SkipDB

A API pública usa `GET https://api.skipdb.tv/api/segments?imdb_id=tt0944947&season=6&episode=4&duration=3520&adjust=none`. IMDb é a chave; `duration` é em segundos, enquanto os segmentos usam milissegundos. Retorna `intro`, `recap`, `outro` e `preview`, com confiança e classificação de correspondência. Leitura não exige chave e tem limite documentado de 120 consultas/minuto. Busca/metadados têm limite de 30/minuto; dump, 6/minuto. Escrita exige identidade e não faz parte desta integração. [Contrato oficial](https://skipdb.tv/docs).

O dump oficial é atualizado diariamente. A documentação da API e a página de dados divergem quanto a exportar somente aprovados ou também pendentes/rejeitados: o importador precisa conferir o payload real e aceitar apenas `status: approved`, sem ressuscitar registros desabilitados. [Dados oficiais e endereço do dump](https://skipdb.tv/data).

O código SkipDB é AGPL-3.0; os dados têm ODbL 1.0 com **Service Provider Reciprocity**. A licença exige atribuição e, quando usados para alimentar/validar um banco de marcações de aplicativo público, disponibilização dos registros correspondentes em formato aberto, sem login. A exceção descrita é a consulta somente para exibir ao usuário sem manter aquele banco privado. O projeto optou por manter os dados importados e seus termos numa pasta pública `web/series-markers/open-data/`, separada das contas e das referências de outras fontes. [Licenças](https://skipdb.tv/license), [texto de dados e reciprocidade](https://github.com/SkipDB-TV/skipdb/blob/main/DATA-LICENSE).

Preservar origem, data da coleta, ID da contribuição, duração declarada e votos. Um dump geral não deve ser republicado inteiro: publicar a seleção de registros consumidos pelo projeto, com a licença e os créditos correspondentes. Dados de usuários, reprodução e credenciais não pertencem a esse conjunto público.

## IntroDB.app

`GET https://api.introdb.app/segments?imdb_id=tt0944947&season=6&episode=4` retorna segmentos agregados por IMDb/temporada/episódio. A resposta inclui início/fim em segundos e milissegundos, confiança, quantidade de contribuições e data da atualização. Leitura é gratuita sem chave; a documentação informa fair usage, sem uma cota numérica nessa página. O contrato atual não recebe runtime/edição no GET. [API](https://introdb.app/docs/api), [OpenAPI](https://api.introdb.app/openapi.json).

Os termos permitem uso razoável em players comerciais. Proíbem copiar a base inteira, serviços concorrentes sem autorização e revenda/redistribuição comercial dos dados. Atribuição é apreciada, não obrigatória. Não tratar a palavra “open” como licença para redistribuir um dump comercial. Esta ampliação não adiciona exportação pública dos dados IntroDB; a pasta aberta contém somente os registros SkipDB sujeitos à licença própria. [Termos oficiais](https://introdb.app/docs/terms).

O campo `outro.end_ms` delimita o fim do trecho de créditos; ele não prova sozinho a duração final do arquivo: a orientação oficial admite terminar o outro no início de uma cena pós-créditos. Esse valor não autoriza inferir edição ou cortar a cena seguinte. [Semântica de créditos/pós-créditos](https://introdb.app/docs/best-practices).

## Identidades iniciais

Os pares abaixo foram conferidos por consultas públicas a `https://api.theintrodb.org/v3/media?imdb_id=<IMDb>&season=1&episode=1`, que retornaram o `tmdb_id` correspondente. TheIntroDB.org e IntroDB.app são serviços diferentes; esta consulta de identidade não licencia dados de um como se fossem do outro.

| Série | IMDb | TMDB |
| --- | --- | --- |
| Game of Thrones | tt0944947 | 1399 |
| O Senhor dos Anéis: Os Anéis de Poder | tt7631058 | 84773 |
| Breaking Bad | tt0903747 | 1396 |
| Stranger Things | tt4574334 | 66732 |
| The Last of Us | tt3581920 | 100088 |
| The Boys | tt1190634 | 76479 |
| Suits | tt1632701 | 37680 |
| The Walking Dead | tt1520211 | 1402 |
| Wednesday / Wandinha | tt13443470 | 119051 |
| Reacher | tt9288030 | 108978 |
| Better Call Saul | tt3032476 | 60059 |
| Lost | tt0411008 | 4607 |
| House of the Dragon / A Casa do Dragão | tt11198330 | 94997 |
| Dark | tt5753856 | 70523 |

Para House of the Dragon e Dark, a consulta desse episódio respondeu 404; os IDs TMDB foram conferidos nas páginas oficiais [94997](https://www.themoviedb.org/tv/94997-house-of-the-dragon) e [70523](https://www.themoviedb.org/tv/70523-dark). Ausência de marcações em um episódio não invalida o título nem autoriza copiar tempos de outro. O contrato de resolução IMDb→TMDB está documentado pelo [cliente oficial TheIntroDB](https://github.com/TheIntroDB/theintrodb-npm/blob/main/README.md).

A lista delimita o cadastro inicial; não promete cobertura de todos os episódios. A cobertura efetivamente importada deve ser obtida do relatório do importador e do inventário do banco, contando apenas registros aprovados e distinguindo os que não possuem duração. O cadastro de uma série sem dados não cria tempos fictícios.

## Duração, edição e cenas adicionais

`exact` no SkipDB significa uma correspondência de runtime dentro da tolerância da fonte; não comprova que dois arquivos tenham os mesmos cortes. `agnostic` não teve duração para comparar; `out-of-range` é incerto. Não aplicar automaticamente deslocamentos estimados, duração média da abertura da temporada ou porcentagens genéricas. Referências comunitárias são apenas diagnósticas, mesmo com runtime semelhante. Somente marcações verificadas e vinculadas à edição/fonte, ou marcações locais explícitas do usuário, habilitam saltos conforme o [contrato do player](marker-playback-verification.md).

Manter as fontes separadas. Há divergências reais entre as bases nas amostras consultadas, inclusive nos episódios de teste; não calcular uma média para inventar um terceiro horário. A pesquisa confirma disponibilidade dos dados, não conferência visual dos arquivos WPLAY.

`outro` pode anteceder `preview` ou uma cena pós-créditos. Guardar os segmentos adicionais na proveniência e não interpretar o início dos créditos como prova de que toda a narrativa terminou. O modelo atual de `creditsStart` não representa sozinho todas essas situações; a automação deve suprimir referências ambíguas até poder preservar a cena adicional. As regras existentes estão em [reprodução de séries](series-playback.md) e no [catálogo de marcações](../web/series-markers/README.md).

## AniSkip: somente anime

É uma opção futura para anime, não uma fonte para estas séries live action. A documentação oficial usa `GET /v2/skip-times/{animeId}/{episodeNumber}?types=op&types=ed&episodeLength=0`: `animeId` é MyAnimeList, e os tempos vêm em segundos, junto da duração declarada de cada contribuição. `0` solicita versões sem filtrar pela duração. Os tipos incluem `op`, `ed`, `mixed-op`, `mixed-ed` e `recap`. Há também `/v2/relation-rules/{animeId}` para regras de numeração. [Swagger oficial](https://api.aniskip.com/api-docs), [esquema servido pelo Swagger](https://api.aniskip.com/api-docs/swagger-ui-init.js).

Uma integração precisa mapear série/temporada/episódio para o MAL e a numeração corretos, inclusive quando uma temporada corresponde a vários cours. Não reutilizar IMDb/TMDB como MAL nem presumir que o episódio 1 de cada temporada mantém o mesmo cadastro. Conferir a duração da contribuição; diferenças de cortes não se resolvem multiplicando todos os tempos por uma proporção.

Uma consulta pública a MAL `9253`, episódio 1, respondeu HTTP 200, com abertura e encerramento e header `X-RateLimit-Limit: 120`; o header não informa sozinho a janela dessa cota. O repositório do servidor tem licença MIT para o **código**; não foi localizada nesta pesquisa uma licença separada que autorize redistribuir toda a base de contribuições. AniSkip não foi ativado por esta etapa. [Repositório oficial](https://github.com/aniskip/aniskip-api).
