# Backend de Séries — etapa reservada

Esta pasta é uma reserva documentada; não contém uma segunda implementação. A etapa atual extrai TV. Catálogo, temporadas, episódios e detalhes continuam nos providers/módulos VOD existentes, e o transporte permanece compartilhado com Filmes. Agendamento/revisão de marcadores continuam nos módulos atuais `lib/series-marker-scheduler.mjs` e `lib/series-marker-review.mjs`.

Na etapa de Séries, preservar IDs de série/episódio, edição, duração, retomada e próxima reprodução, sem criar estado de TV ou autenticação paralela. Separar o serviço de marcadores do transporte de vídeo; não converter estimativas em tempos confirmados. O nome `serie` desta pasta não altera o contrato `series` dos endpoints ou da biblioteca.

Esta reserva não certifica reprodução ou pulos automáticos. Consulte o [mapa da etapa de TV](../../docs/tv-modularization-20261016.md).
