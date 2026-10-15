# Evidências da publicação de catálogos

Projeto autorizado: `wnicimkmzswksaqdtgdv`. Medições abaixo usam somente agregados, fases fixas e códigos; não incluem credenciais ou dados pessoais.

Em 15/10/2026, às 15:12 UTC, a publicação de Filmes foi cancelada com SQLSTATE `57014` após 59.728 ms. O diagnóstico por fase, medido com `clock_timestamp()`, mostrou:

| Fase | Duração(ms) |
| --- | ---: |
| Inicial/checagens/classificação restante |4206 |
| Construção JSON completo |15833 |
| Categorias |354 |
| Metadados dos títulos |17087 |
| Desativação de categorias |74 |
| Desativação de títulos |4706 |
| Inserção de referências de arte |5835 |
| Limpeza de referências de arte |5633 |
| Snapshot até o cancelamento |5960 |

O último comando interrompido foi a gravação em `provider_catalog_cache`; o tempo acumulado anterior já consumia aproximadamente 54 s. A medida não comprova que o CHECK ou a compressão do snapshot isoladamente fossem a causa.

A migração `20261015150309` separou jobs por `provider_key/scope_hash/media_type`, preservando o job original de Filmes, 897 páginas brutas e 18.612 IDs normalizados. Às 15:11 UTC, Séries já havia recebido 24 páginas/1.012 ocorrências em tarefa independente. A prévia de 120 itens continuava explicitamente incompleta.

A migração `20261015151331` prepara o JSON completo numa tabela privada em chamada anterior, com validações de tarefa/tipo/lease/fonte/cursor/posições e contagens. A visibilidade dos índices e do snapshot permanece atômica. Preparação não equivale a publicação completa. A tabela privada é removida somente no sucesso final; cancelamento preserva a preparação para retomada.

Às 15:23 UTC, o JSON privado dos 18.612 filmes já estava confirmado. A transação final voltou a exceder o prazo, desta vez antes do snapshot: a gravação de mídia levou 50.657 ms, contra 17.087 ms na medição anterior. O material preparado permaneceu preservado. Isso motivou a publicação por gerações com cópia limitada de índices, em vez de outra ampliação de timeout.

Verificação local da preparação: `node tools/test-catalog-domains.mjs <caminho-do-PGlite>` cobriu 36 asserções, incluindo lease vivo, preservação de staging, filas independentes, RLS/adulto, cancelamento da preparação, rollback final, revisão divergente e retomada. O coletor passou em 24 testes. A confirmação remota completa e o tamanho integral do catálogo devem ser registrados após publicação real; fixtures não substituem essa evidência.

## Publicação completa confirmada

A migração `20261015152804` foi aplicada e registrada. Ela copia até 256 títulos por chamada para uma geração ainda invisível a leitores autenticados; o último commit troca conjuntamente o header e o registro da geração visível. O Realtime publica somente esse registro pequeno. `provider_catalog_cache`, `catalog_media`, `catalog_categories` e `catalog_artwork_refs` ficaram fora da publicação Realtime.

O job original de Filmes, `1664acfc-f76a-41d7-ad08-0bb86c9b8f37`, concluiu às **15:51:37 UTC** de 15/10/2026. O progresso confirmou os 18.612 índices copiados. A preparação e o staging foram removidos pela conclusão bem-sucedida, após sua preservação durante as tentativas anteriores. Séries havia concluído às 15:37 UTC de forma independente.

Às 15:59 UTC, `node tools/verify-catalog-live.mjs` confirmou os três catálogos publicados pela API real:

| Catálogo | Itens completos | Disponíveis com adulto bloqueado | Categorias brutas | JSON integral (bytes) | Leitura e verificações (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| TV | 760 | 659 | 39 | 225.748 | 671 |
| Filmes | 18.612 | 18.211 | 37 | 14.074.811 | 14.003 |
| Séries | 8.124 | 8.118 | 35 | 5.996.126 | 9.098 |

O verificador usou uma sessão Auth própria e temporária da conta validada, revogada ao terminar. Conferiu a leitura integral contra as contagens SQL, unicidade dos IDs, correspondência do filtro adulto, ausência de URLs de transporte/segredos no JSON global e negação de outra partição. Não alterou favoritos, progresso ou preferências. Os tempos acima incluem as operações de leitura e as verificações do script; não são medidas isoladas do banco ou da interface.

## Domínios consultáveis e validação SQL

A migração `20261015154822` foi aplicada e registrada após a publicação. Ela oferece nove views somente de leitura: `catalog_movies`, `catalog_series`, `catalog_live` e, para cada tipo, os sufixos `_categories` e `_cache`. Todas usam `security_invoker=true`, herdam o RLS do chamador e limitam os resultados à geração visível. Até leitores de serviço nessas views ignoram gerações ainda não publicadas. Uma prévia não aparece na view de cache completo.

A fixture PostgreSQL foi ampliada para **122 asserções aprovadas**, cobrindo as 75 verificações de preparação/gerações e 47 de views: isolamento por conta e tipo, nenhuma leitura anônima, somente SELECT para o navegador, contexto invoker, geração oculta e prévia sem header completo. A asserção remota confirmou o histórico das duas migrações, as nove views invoker, o registro Realtime pequeno e a conclusão do job original de Filmes.

A reprodução de vídeo e a experiência visual final continuam com validação separada. Catálogos publicados não comprovam, por si só, a disponibilidade de cada transmissão WPLAY ou a correspondência de cada abertura de episódio.

## Leitura simultânea no primeiro acesso

A leitura sequencial acima passou, mas o teste da interface com os três catálogos frios encontrou SQLSTATE `57014` ao ler o JSON integral de Filmes. O servidor respondeu HTTP 500 após 10.843 ms; não era o timeout de transporte do cliente. Uma medição com o papel `authenticated` e RLS ativo separou o custo: header 54 ms, descompactação/conversão do JSON 6.174 ms e serialização equivalente à resposta 6.168 ms. Sob concorrência, a conversão chegou a 15.510 ms. Portanto, a publicação completa estava correta, mas sua leitura monolítica era instável sob carga.

A correção usa os índices já publicados, sem nova migração ou ampliação de timeout. `lib/catalog-snapshot-reader.mjs` consulta até 1.000 registros por chamada REST, com no máximo duas leituras limitadas simultâneas e fila compartilhada entre os domínios. A medição de 1.000 itens produziu aproximadamente 841 KB: 1.329 ms na primeira agregação e 26 ms na serialização seguinte. Headers pequenos ficam fora dessa fila.

Esses lotes são internos ao servidor. A interface continua recebendo **uma resposta completa por catálogo** e guardando-a por 24 horas. O leitor verifica snapshot, geração, revisão, expiração e contagens antes/depois, além de tipo, IDs únicos e classificação adulta em cada lote. Resposta parcial, cancelamento, geração trocada ou erro não vira catálogo completo. Uma atualização que falha preserva o cache anterior sem renovar seu prazo nem aparentar uma resposta nova bem-sucedida. Uma segunda sessão ainda autorizada pode retomar uma leitura compartilhada abandonada pela primeira, com somente uma tentativa adicional.

`node tools/verify-catalog-live.mjs --concurrent` passou contra o Supabase real: TV 760/659 em **1.504 ms**, Séries 8.124/8.118 em **7.022 ms** e Filmes 18.612/18.211 em **17.054 ms**. Os três transportes completos terminaram sem timeout SQL; os controles adicionais de contagem SQL, adulto, unicidade, segredos e outra partição também passaram. A execução completa do verificador levou 21.348 ms e revogou sua sessão própria.

Os testes de transporte, runtime e API somaram **48 aprovações**, incluindo geração trocada durante a leitura, lote ausente, duplicação, tipo incorreto, classificação divergente, interrupção de conta, fila entre TV/Filmes/Séries, cache anterior sem renovação por falha, logout do proprietário de uma leitura compartilhada e limite inclusivo de categorias.
