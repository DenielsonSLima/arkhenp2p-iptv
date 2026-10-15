# Busca e cálculos de catálogo no Supabase

Migrações aplicadas e registradas: `20261015164720_arkhen_catalog_query_models.sql` e `20261015164722_arkhen_catalog_genre_labels_utf8.sql`.

A busca global passou para `arkhen_global_search`. O servidor exige pelo menos três caracteres após normalizar acentos, caixa e espaços; combina todas as palavras, priorizando título exato, início do título, trecho do título, palavras no título e, por último, metadados. A normalização NFD coincide com a interface. Os cálculos usam campos derivados pequenos de `catalog_media`, mantidos automaticamente nas publicações. Não foi criado índice textual GIN: a medição abaixo corresponde à filtragem desses campos, sem descompactar todos os JSONs de metadados a cada busca.

A função valida o usuário e sua partição, lê somente a geração publicada e considera a visibilidade adulta definida pelo backend. As exclusões pessoais recebidas na chamada afetam tanto os resultados quanto as contagens. Cada chamada retorna até 120 títulos; as contagens por TV, Filmes e Séries abrangem todos os resultados correspondentes. Selecionar uma aba pesquisa aquele domínio no banco, preservando as contagens das três abas. Essa limitação aplica-se à resposta da busca; o catálogo continua integral no cache diário.

`arkhen_catalog_read_model` fornece os cálculos compartilhados de cada domínio. `catalog_navigation_cache` armazena uma versão para adulto bloqueado e outra para desbloqueado, por provedor, escopo, tipo e geração. O modelo inclui:

- Todas as identidades ordenadas por nome, data numérica de inclusão e nota.
- Categorias e gêneros com identidades integrantes e contagens completas.
- Lançamentos deduplicados por título/ano e até 36 candidatos a destaque por domínio.
- Snapshot, geração, revisão e validade que permitem conferir correspondência com os metadados completos.

Os nomes são comparados sem acentos e com segmentos numéricos ordenados numericamente. As categorias conservam seus IDs originais; o frontend reconcilia os grupos visuais que juntam mais de um ID. Gêneros usam a taxonomia canônica já existente na interface, combinando metadados e categorias reais. Data de inclusão mantém a regra numérica do catálogo; lançamentos também aceitam a data ISO usada na página inicial.

A função de serviço `arkhen_prepare_catalog_read_model` prepara as duas versões em uma transação. O cron `arkhen-catalog-navigation` verifica uma geração pendente por minuto, sem reconstruir modelos já completos. A troca da geração torna o modelo anterior invisível a leitores autenticados. Antes da preparação, a RPC retorna ausência de modelo; isso não declara uma preparação parcial como concluída. A interface continua responsável por guardar o catálogo e seu modelo por 24 horas, desenhar os cards e aplicar interações pessoais. Favoritos, histórico, progresso e preferências não entram no cache compartilhado. Esta entrega não representa migração de todo cálculo visual ou privado para SQL.

## Verificações

Antes do `ALTER TABLE`, foram medidas 27.496 linhas, heap de 31.236.096 bytes e total de 89.341.952 bytes incluindo índices e TOAST. A migração transacional terminou dentro do limite local de 55 segundos, com espera por lock limitada a cinco segundos. Não houve ampliação de limites globais do PostgreSQL.

`tools/test-catalog-query-models.mjs` passou em 40 asserções PostgreSQL, incluindo RLS, usuário expirado, outra partição, ausência de acesso anônimo e de escrita, mínimo de caracteres, normalização NFD, ranking, múltiplas palavras, totais maiores que a janela de resultados, exclusões pessoais, visibilidade adulta, ordens completas, gêneros, deduplicação de lançamentos, troca de geração e recuperação de rótulos Unicode.

Uma verificação adicional identificou que o transporte de SQL pelo PowerShell 5 substituía acentos nos literais por U+FFFD. O helper passou a enviar bytes UTF-8 com charset explícito. A migração `164722` restaurou somente a função de rótulos e os gêneros dos modelos compactos existentes, incluindo sua ordem alfabética; os catálogos não foram recriados. A prova remota confirmou os códigos Unicode de `ç`, `ã` e `í` e a ausência de caracteres de substituição nos modelos.

`node tools/verify-catalog-query-live.mjs` passou com JWT próprio temporário, revogado no final, sem alterar a biblioteca. A primeira busca global levou 2.413 ms e encontrou 46 títulos. As consultas seguintes levaram 473 ms para Séries, 576 ms para TV e 338 ms para Filmes; esta última encontrou 4.081 títulos e retornou os primeiros 120. As contagens completas de todas as abas foram preservadas.

| Modelo com adulto bloqueado | Itens | Categorias | Gêneros | Bytes | Leitura e conferência do header |
| --- | ---: | ---: | ---: | ---: | ---: |
| TV | 659 | 37 | 0 | 24.110 | 487 ms |
| Filmes | 18.211 | 36 | 19 | 1.327.303 | 1.156 ms |
| Séries | 8.118 | 34 | 13 | 604.257 | 721 ms |

As identidades e contagens foram comparadas com os headers reais; todas as ordens continham cada item exatamente uma vez, as associações de categorias/gêneros referenciavam itens existentes, a partição estrangeira foi negada e os resultados não continham transporte ou credenciais. Esses tempos medem chamadas reais com verificações, não uma previsão de latência para todos os dispositivos. A validação visual final permanece separada.
