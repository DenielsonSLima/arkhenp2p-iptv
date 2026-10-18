# Incidente de disponibilidade do Supabase em 16/10/2026

Estado: instabilidade de conexão comprovada; pausa pontual confirmada por readback em aproximadamente 23h04 UTC (20h04 locais). Tamanhos medidos depois da pausa; saúde/CPU atuais sem certificação. Projeto autorizado: `wnicimkmzswksaqdtgdv`. Nenhuma conta, biblioteca, credencial ou URL privada foi copiada para este relatório.

## Evidências e limites

- As capturas fornecidas pelo usuário mostram CPU em 99%, banco/PostgREST/Auth/Storage `Unhealthy`, cancelamentos `57014`, perda de conexão `08006` e desligamento/recusa de conexão `57P01`/`57P03` por volta de 19h34–19h36 locais. Não identificam quem iniciou o desligamento. O integrador não reiniciou o projeto Supabase.
- A configuração carregada pelo backend aponta para o projeto correto. A Management API respondeu `ACTIVE_HEALTHY` para o recurso, mas isso não certificou a conexão ao PostgreSQL: `SELECT 1` recebeu conexão recusada na porta 5432 e a leitura REST mínima autenticada expirou.
- Uma leitura administrativa conseguiu confirmar job 9, `arkhen-home-identities`, ativo a cada minuto. As imagens também mostram sua chamada com lote 1.000 e duração de aproximadamente 15,9 s. A auditoria de [Home e outros agendamentos](home-identity-cron-20261016.md) distingue custos demonstrados de amplificadores possíveis.
- O usuário esclareceu os tamanhos exibidos: `catalog_media` 120 MB, `catalog_artwork_refs` 35 MB e `catalog_categories` 136 kB. Portanto, somente uma das tabelas informadas excede 100 MB. As primeiras consultas de tamanho expiraram; uma leitura limitada posterior à pausa respondeu com os números abaixo. Não se conclui defeito pelo tamanho isolado e não se apagam tabelas para liberar espaço sem diagnóstico.

| Tabela | Total | Dados + TOAST | Índices |
| --- | ---: | ---: | ---: |
| `catalog_media` | 119,97 MiB | 60,10 MiB | 59,87 MiB |
| `catalog_artwork_refs` | 35,31 MiB | 13,98 MiB | 21,33 MiB |
| `catalog_categories` | 136 KiB | 72 KiB | 64 KiB |

Bytes retornados por `pg_total_relation_size`, `pg_table_size` e `pg_indexes_size`: mídia 125.796.352 / 63.021.056 / 62.775.296; referências 37.027.840 / 14.663.680 / 22.364.160; categorias 139.264 / 73.728 / 65.536. Estatísticas de tuplas vivas/mortas retornaram zero nas três tabelas e datas de manutenção nulas. Esses contadores não demonstram tabelas vazias nem ausência de bloat; faltam estatísticas utilizáveis e medição de retenção. Não foi executada contagem completa ou varredura para estimar bloat.

A leitura complementar de atividade/duração dos jobs voltou a expirar, mesmo depois de uma consulta de tamanhos ter respondido. Uma leitura reduzida só de atividade e o health check administrativo também expiraram. A comunicação permanece intermitente; não se conclui recuperação integral pela resposta de uma consulta. Novas tentativas de medição/retomada devem partir de uma mudança de saúde, sem repetir consultas continuamente durante a saturação.

## Contenção tentada e estado remoto

Foi preparada uma pausa reversível somente do backfill de Home, preservando os demais jobs, o comando, a cadência, o histórico e os dados. A primeira tentativa foi recusada porque `SELECT FOR UPDATE` exige privilégio que não estava concedido em `cron.job`; a transação não alterou nada. Essa trava foi retirada, mantendo a função oficial `cron.alter_job`, sem conceder permissões novas.

A tentativa seguinte recebeu `57014` antes da alteração. Uma instrução direta, guardada por jobid/nome/comando/cadência, excedeu o prazo HTTP; o readback posterior voltou a mostrar `active=true`. Uma tentativa pontual durante essa janela de resposta também excedeu o prazo HTTP. O readback final, feito em outra chamada administrativa por volta de 23h04 UTC, confirmou job 9, nome e cadência preservados, **`active=false`**. Assim a pausa está comprovada, apesar da resposta HTTP anterior ter expirado. Nenhuma retomada foi enviada.

Não houve exclusão, `TRUNCATE`, `VACUUM FULL`, aumento de compute/timeout global, cancelamento de sessões ou alteração de RLS. A pausa evita novas chamadas do backfill; não equivale a cancelamento de chamada já em execução, restauração dos serviços ou comprovação de queda de CPU.

Scripts técnicos revisáveis, fora das migrations e sem execução automática:

- [Pausa pontual](../supabase/operations/pause-home-identities.sql): somente o job identificado e a definição observada; divergência produz zero alterações. A existência do arquivo não comprova aplicação.
- [Tamanhos e atividade](../supabase/operations/inspect-database-load.sql): consultas a estatísticas, sem payloads nem texto das consultas de usuários.

Depois da pausa, obter tamanhos, estatísticas e duração por job; verificar pendências e plano sem execução antes de medir um lote pequeno. A retomada do backfill depende de necessidade comprovada e trabalho limitado. O trigger já preenche identidades nas novas inserções/mudanças de metadados.

## Relação com as falhas do aplicativo

A indisponibilidade do banco é compatível com falhas de biblioteca, capas globais e RPCs de Home/recomendações, mas não prova ser a origem de todas as falhas de mídia. O transporte WPLAY e o banco têm responsabilidades distintas. O loop de MP4/429 e a imposição da ponte experimental tinham causas adicionais no código, tratadas separadamente no lote local.

No código local, bootstrap de nuvem tem espera progressiva por conta/geração, falha transitória de arte retorna 503 em vez de uma falsa negativa 403, e falha não apaga a projeção válida da mesma conta. Essas proteções não restauram um PostgreSQL indisponível nem certificam serviços remotos recuperados.

Foi corrigida ainda a inicialização hospedada: o entrypoint importado pela Vercel deixava `cloud=null`. A fábrica local agora lê `ARKHEN_SUPABASE_CONFIG` validada no servidor hospedado, sem fallback ao arquivo privado. Ausência/erro conserva a tela de entrada e diagnóstico sanitizado. Essa mudança ainda não foi publicada e nenhuma variável remota foi alterada.

Verificação final do lote local: 146 testes sintéticos aprovados em 14 arquivos; sintaxe de 45 arquivos e compilação da interface sem avisos. Aplicativo reiniciado por `npm start` em localhost:4173, sem ponte experimental. Sem navegador, transmissão ou teste visual; Séries permanece na etapa posterior de modularização.

Fontes oficiais para interpretar os eventos: [códigos PostgreSQL](https://www.postgresql.org/docs/current/errcodes-appendix.html), [diagnóstico de CPU do Supabase](https://supabase.com/docs/guides/troubleshooting/high-cpu-usage), [alteração de jobs no pg_cron](https://github.com/citusdata/pg_cron#altering-a-cron-job). Evidências remotas desta rodada foram consultas administrativas/REST limitadas; sem navegador ou reprodução de mídia.
