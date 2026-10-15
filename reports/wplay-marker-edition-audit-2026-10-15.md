# Conferência das ofertas WPLAY e das edições

Inventário obtido em 15/10/2026 por uma fonte de provedor já autorizada e cifrada no backend. A inspeção não leu o navegador pessoal, não exportou credenciais/URLs de vídeo e não alterou biblioteca ou progresso. Os resultados são metadados da oferta naquele instante, não garantias de disponibilidade futura.

| Oferta nativa | ID | Episódios/rótulos únicos | Observação |
| --- | --- | ---: | --- |
| Game of Thrones (2011) | 999725200 | 73 | 84 fontes: alguns episódios têm mais de um arquivo. |
| Vikings (2013) | 131129 | 88 | T5E20 não consta nesta oferta; o inventário público tem 89 episódios. |
| Vikings (2013), LEG | 999726546 | 9 | Somente T1; não presumir o mesmo corte da versão principal. |
| One Piece anime (1999) | 148757 | 875 | Números de episódios absolutos; algumas temporadas diferem da oferta LEG. |
| One Piece anime (1999), LEG | 87812597 | 1.180 | 1.190 fontes; rótulos únicos incluem episódios absolutos com agrupamento diferente. |
| ONE PIECE com atores (2023) | 130931 | 16 | T1/T2, oito episódios cada; outro IMDb, não compartilhar marcadores com o anime. |
| Os Anéis de Poder (2022) | 999730340 | 16 | T1/T2, oito episódios cada; T3 anunciada nas bases públicas não é oferta WPLAY capturada. |
| A Sociedade do Anel (2001) | 58125 | 1 filme | Caminho de filme, sem temporada/episódio artificial. |
| As Duas Torres (2002) | 58148 | 1 filme | Referência pública de créditos exige identificar a edição. |
| O Retorno do Rei (2003) | 87224 | 1 filme | Referência SkipDB de 98 minutos não certifica o arquivo completo. |

O inventário bruto sanitizado está em `.local/target-media-inventory.json`. Não contém endereços de reprodução. O anime não pode usar a posição na lista para renumerar episódios: as duas ofertas discordam no agrupamento a partir das temporadas 22/23. Um resultado HTTP válido para temporada/número não comprova que ambas as bases estão falando do mesmo episódio.

## Duração lida dos arquivos

Foi lido o cabeçalho MP4, sem download integral:

| Oferta/episódio | ID nativo de episódio | Duração MP4 |
| --- | --- | ---: |
| Game of Thrones T1E1 | 12644164 | 3.697,319 s |
| Game of Thrones T5E1 | 12644120 | 3.129,669 s |
| Vikings T1E1 | 12309020 | 2.651,191 s |

O hash amostrado de cabeçalho/cauda foi usado somente no diagnóstico privado. Não é prova audiovisual de um limite de abertura e não foi publicado como edição verificada. Uma duração próxima da referência não equivale à mesma montagem.

## Inspeção visual real: Game of Thrones T5E1

Um Chrome isolado decodificou a oferta nativa de T5E1, com duração de 3.129,668208 s. A inspeção observou:

- 6 s: vinheta HBO; 60 s: mapa da abertura; 105 s: título Game of Thrones.
- 113 s: crédito de direção em fundo escuro; 117 s: a primeira cena já começou.
- 123 s e 180 s: conteúdo do episódio.

Isso delimita a transição observada entre **113 e 117 segundos**, mas não certifica um segundo exato para um salto. Não foi aplicado um horário de 198 segundos a esse episódio. O usuário não identificou em qual episódio observou 3:18; essa observação não pode ser atribuída a T5E1.

A captura privada `.local/media-boundaries-999725200-S05E001-0.png` reúne os quadros. As tentativas posteriores em 198/205 s não concluíram; o provedor retornou HTTP 429, sem `Retry-After`. As requisições de mídia foram suspensas. Não houve inspeção audiovisual completa dos demais episódios ou dos créditos finais. Nenhuma marcação foi promovida a `verified` por essa amostra.

## Resultado e continuidade

As discrepâncias reproduzíveis e URLs públicas estão na [auditoria de fontes](marker-source-audit-2026-10-15.md). A nova política impede que referências comunitárias, interseções de fontes ou apenas runtime semelhante produzam saltos executáveis. Marcação manual explicitamente feita no aparelho continua sendo uma entrada separada.

A renovação das referências pela fila Supabase é uma consulta das APIs, não uma verificação visual dos arquivos. A conclusão de cada consulta deve manter esse estado explícito. A numeração, as variantes e a prova de edição precisam acompanhar uma certificação futura; não usar um deslocamento fixo nem a aprovação comunitária como substitutos.
