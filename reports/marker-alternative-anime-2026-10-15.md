# Alternativas públicas para marcadores de anime — 15/10/2026

AniSkip e AnimeSkip responderam com dados reais de One Piece nesta auditoria. Nenhum cadastro foi criado, nenhum token pessoal foi usado e nenhuma marcação foi alterada. As respostas sanitizadas estão em [marker-alternative-anime-2026-10-15.json](marker-alternative-anime-2026-10-15.json). Elas ampliam as referências disponíveis, mas não certificam a edição WPLAY.

## AniSkip

O endpoint público `GET https://api.aniskip.com/v2/skip-times/{animeId}/{episodeNumber}` usa ID **MyAnimeList**, número de episódio, `types[]` e `episodeLength` em segundos. A consulta aceita `op`, `ed`, `recap`, `mixed-op` e `mixed-ed`. A duração zero desativa o filtro de duração; isso não devolve todas as variantes: o serviço seleciona uma entrada por tipo. As duas consultas MAL21/E1 e MAL21/E62 foram HTTP200 sem chave. [Documentação oficial](https://api.aniskip.com/api-docs), [serviço](https://github.com/aniskip/aniskip-api/blob/main/src/skip-times/skip-times.service.v2.ts).

O código público limita a leitura a **120 solicitações/minuto**; as respostas observadas trouxeram `x-ratelimit-limit:120`. A seleção filtra registros com votos maiores que −2, aceita diferença de duração de até **20 segundos** e ordena por votos. A resposta entrega intervalo, tipo, ID e duração, sem pontuação numérica de confiança nem prova do arquivo. Uma correspondência do filtro continua sendo aproximada. [Controlador](https://github.com/aniskip/aniskip-api/blob/main/src/skip-times/skip-times.controller.v2.ts), [consulta de seleção](https://github.com/aniskip/aniskip-api/blob/main/src/repositories/skip-times.repository.ts).

| One Piece MAL21 | Abertura AniSkip | Duração cadastrada | Outro resultado |
| --- | --- | ---: | --- |
| Episódio1 | 28,783–118,783s | 1.500,040s | Ending1.387,996–1.500s, duração1.500,146s |
| Episódio62 | 18,613–123,613s | 1.501,194s | Ending1.380–1.500s, duração1.501,125s |

A consulta E1 sem filtro também trouxe recap e segmentos mistos associados a durações1.435–1.444s. Esses registros não devem ser reunidos como se pertencessem ao mesmo arquivo. Na [auditoria anterior](marker-source-audit-2026-10-15.md), o IntroDB trouxe exatamente28,783–118,783s para a abertura de E1. A igualdade não prova que uma API importou a outra, mas também não serve como confirmação independente. Não foi encontrada evidência suficiente para afirmar independência integral dos conjuntos.

O repositório do software é [MIT](https://github.com/aniskip/aniskip-api/blob/main/LICENSE). Não foi identificada nesta consulta uma licença separada e explícita para redistribuição integral da base de marcações. Isso deve ser esclarecido antes de planejar espelhamento completo; o código aberto não determina sozinho a licença dos dados.

## AnimeSkip

O endpoint atualmente testado foi `POST https://anime-skip.com/api/graphql`. A documentação exige `X-Client-ID`, distingue esse identificador de um token pessoal e oferece um ID compartilhado para experimentação, sujeito a limite forte. Esse ID público documentado funcionou em três consultas de leitura, sem conta nem Authorization. Nenhuma taxa numérica gratuita foi confirmada para ele; a implementação aplica o limite `rateLimitRpm` de cada cliente. Para integração contínua, a documentação recomenda criar um client ID próprio. [Documentação no repositório atual](https://github.com/anime-skip/web/blob/v2/server/assets/api-docs.md), [exemplo oficial do cliente compartilhado](https://github.com/anime-skip/api-client-ts), [limitação por cliente](https://github.com/anime-skip/web/blob/v2/server/plugins/apply-rate-limit.ts).

Os IDs internos são UUIDs; os vínculos externos consultados apontam para **AniList21**, que não deve ser confundido automaticamente com o contrato MAL21 da outra API. Episódios possuem `season`, `number`, `absoluteNumber`, `baseDuration`; marcações têm `at`, `type` e `source`. O esquema ainda permite duração e deslocamento específicos de uma URL. Não há campo equivalente a fingerprint audiovisual que comprove a edição WPLAY. [Modelos oficiais](https://github.com/anime-skip/web/blob/v2/server/graphql/schema/models.gql), [consultas](https://github.com/anime-skip/web/blob/v2/server/graphql/schema/queries.gql).

| Registro consultado | Resultado real | Duração base |
| --- | --- | ---: |
| E1, UUID44569721-0b7a-473a-b47b-7fd56f7689d6 | Intro22s; Canon132,184725s; Preview1.467,5s | 1.497,0614s |
| E62, UUID2107b6d2-460c-4382-9a2e-cc80b1c0e981 | Intro0/130,888783s; Recap133,970671/193,25522s; Canon195,783152s; Credits1.373,555974s; Preview1.449,810662s | 1.477,96s |

AnimeSkip representa **transições de tipo**, não pares `start/end` prontos. E1 permite inferir a transição Intro→Canon em132,184725s; E62 contém pontos repetidos do mesmo tipo, exigindo normalização. Os registros acima declaram `source:ANIME_SKIP`. O esquema também admite `BETTER_VRV`, portanto a proveniência precisa ser preservada, e resultados importados não devem contar como fonte independente adicional. [Enum de proveniência](https://github.com/anime-skip/web/blob/v2/server/graphql/schema/enums.gql).

Há inconsistências concretas na base: a busca retornou três entradas chamadas One Piece vinculadas a AniList21, com1.197,565 e11 episódios. Na primeira coleção, um episódio cujo `number` é665 apareceu com `absoluteNumber:1`. O E62 consultado tem `number:62`, `absoluteNumber:null`, `season:null` e título sobre a baleia Laboon. Por isso, nem o primeiro resultado de busca nem `absoluteNumber` isoladamente podem criar a associação WPLAY. Não foi inventado um vínculo para a oferta do provedor.

O backend público anterior declara [GPL-3.0](https://github.com/anime-skip/public-api/blob/main/LICENSE); isso descreve o software. Não foi confirmada licença separada para espelhamento integral dos dados no material consultado. As consultas reais acima confirmam acesso público experimental, não disponibilidade irrestrita nem compromisso de serviço.

## Aplicação possível no ARKHEN

Adicionar AniSkip como fonte especializada de anime e AnimeSkip como confronto adicional é tecnicamente possível. O caminho requer vínculo explícito IMDb/TMDB↔MAL/AniList, episódio absoluto validado, proveniência e duração por variante. O diagnóstico deve mostrar discordâncias — por exemplo, E1 termina118,783s em AniSkip e transiciona para Canon132,185s em AnimeSkip — antes de certificar a edição do provedor. Nenhum offset foi calculado pela diferença entre durações e nenhum dado comunitário desta auditoria foi promovido a `verified`.

Foram feitas apenas duas leituras de segmentos AniSkip e três consultas GraphQL AnimeSkip, em sequência, sem varrer milhares de episódios individualmente. A consulta compacta de inventário retornou1.197 registros; somente candidatos relevantes foram retidos no artefato sanitizado. Nenhuma requisição de vídeo WPLAY foi feita nesta investigação.
