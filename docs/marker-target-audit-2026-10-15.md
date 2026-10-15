# Renovação das referências por obra

Em 15/10/2026, a revisão separou identidade da obra, inventário público, oferta WPLAY e comprovação da edição. Uma abertura comunitária de aproximadamente 117 segundos não certifica o limite observado em outro arquivo ou episódio. A [inspeção WPLAY](../reports/wplay-marker-edition-audit-2026-10-15.md) e a [auditoria das fontes](../reports/marker-source-audit-2026-10-15.md) registram os dados e seus limites.

## Identidades e solicitação preparada

| Obra | IMDb | IDs nativos separados | Inventário da fonte | Revisão prioritária |
| --- | --- | --- | ---: | ---: |
| Game of Thrones, 2011 | tt0944947 | 999725200 | 374, incluindo especiais | 73 regulares |
| Vikings, 2013 | tt2306299 | 131129 / 999726546 LEG | 89 | 89 |
| Vikings: Valhalla, 2022 | tt11311302 | 999728421 / 105002 | 24 | 24 |
| One Piece anime, 1999 | tt0388629 | 148757 / 87812597 LEG | 1.169 | 1.169 |
| ONE PIECE com atores, 2023 | tt11737520 | 130931 | 17, incluindo temporada futura | 16 |
| Os Anéis de Poder, 2022 | tt7631058 | 999730340 | 24, incluindo temporada futura | 16 |

Foram preparados nove vínculos nativos e 1.387 consultas de referência; o lote foi enviado, com persistência ainda não confirmada. Os números de inventário não significam episódios disponíveis na WPLAY. Vikings T5E20 não constou na oferta principal capturada. One Piece tem divergências de agrupamento entre fontes; os números absolutos são conservados e nenhuma correspondência IPTV é inferida da posição na lista. A oferta “Game of Thrones - 17 (LEG)”, extras de One Piece, coletâneas e filmes continuam fora desses vínculos.

Os três filmes principais de O Senhor dos Anéis foram identificados como filmes: tt0120737, tt0167261 e tt0167260, IDs nativos58125/58148/87224. O pipeline atual usa série/temporada/episódio. Nenhuma temporada artificial foi criada para esses filmes; sua cobertura e edição exigem um caminho próprio.

## Implementação

- `metadata.mjs` remove somente sufixos de edição conhecidos, inclusive `(LEG)` e `[DUB]`, preservando o ano. IMDb conhecido, ano e TMDB conflitantes são recusados tanto na identidade explícita quanto nos resultados de pesquisa.
- `registry.js` distingue Vikings/Valhalla e as duas adaptações de One Piece. Seus slugs existentes `imdb-tt...` foram preservados. A resolução dinâmica também recusa anos contraditórios.
- Migração `20261015182553` adiciona `audit_priority`, `audit_requested_at`, `audit_next_check_at` e `audit_checked_at` à fila existente, com índice. As permissões/RLS continuam permitindo escrita somente ao backend autorizado.
- O prazo da auditoria é independente do prazo da importação diária. Uma publicação do dump não adia uma revisão já pedida. Quando há auditorias devidas, o worker reserva o ciclo para até dez episódios, com orçamento suficiente para as duas APIs e persistência.
- Ordem: GoT → Vikings → Valhalla → One Piece com atores → anime → Rings. A auditoria consulta ambas as fontes para confronto. A rotina comum mantém SkipDB primário e IntroDB nas lacunas/falhas.
- Evidências permanecem separadas por fonte; falhas não apagam evidência anterior. A auditoria não publica novas edições executáveis nem modifica `verification`. Conclusão de consulta registra explicitamente `editionVerified:false`.
- O PATCH compara `audit_requested_at` e `updated_at`. Uma resposta em voo não pode apagar prioridade ou adiar um novo pedido. Falhas preservam a solicitação e usam prazo próprio de retentativa.
- `tools/refresh-marker-targets.mjs` valida os seis inventários públicos atuais e todos os nove títulos/anos/IDs na geração publicada antes de gravar. O modo normal toma o lease existente. O modo `--prepare-sql` produz uma transação revisável com nova conferência de geração/identidade antes do commit, para aplicação depois da publicação do worker que usa comparação de revisões.

## Verificações e estado remoto

Os testes direcionados de coletor, identidade, planejamento e player passaram: 53 verificações. O fixture PostgreSQL/RLS passou em 44 asserções; a transação concreta de nove identidades e1.387 referências passou em 46 asserções, incluindo proteção contra resposta antiga e preservação de uma fila preexistente.

A migração foi aplicada e sua presença/quatro colunas foram conferidas remotamente. A Edge Function `series-markers-sync` está ACTIVE, versão6, publicada em15/10/2026 às18:37:35.889UTC. A configuração existente `verify_jwt=false` foi preservada junto com a validação constante do segredo dedicado, antes de qualquer acesso ao coletor.

Duas tentativas de enfileirar sob lease encontraram o coletor ocupado e terminaram sem escrita. Em seguida, a transação atômica preparada recebeu HTTP201 do Management SQL. **Essa resposta ainda não comprova persistência nem execução do lote:** o readback por REST excedeu10s em `coverage`, e tanto o agregado administrativo quanto o controle mínimo `SELECT now()` retornaram HTTP544. O plano de controle da CLI continuou informando ACTIVE_HEALTHY. Nenhum limite global foi aumentado e o projeto não foi reiniciado.

Enquanto a leitura permanecer indisponível, os artefatos mantêm `applied:false` e nenhuma auditoria é apresentada como concluída. Não reenviar a transação sem primeiro conferir o lote já enviado. Os relatórios `marker-target-refresh-2026-10-15.json` e `marker-target-refresh-status-2026-10-15.json` distinguem preparação, envio e confirmação de leitura.

Nenhuma referência dos seis títulos foi promovida a `verified`; não houve alteração de favoritos, histórico, progresso ou credenciais. A verificação audiovisual de cada edição permanece pendente.

Em 15/10/2026 às 18:54:49 UTC, o endpoint oficial de saúde retornou HTTP200 em 11,2s e confirmou `UNHEALTHY` para `db`, `auth`, `rest` e `storage`; somente `realtime` retornou `ACTIVE_HEALTHY`. Esse resultado confirma a indisponibilidade dos serviços, mas não identifica sua causa nem prova o resultado da transação enviada. O resumo sem credenciais está em `reports/supabase-project-health-2026-10-15.json`.
