# Home privada calculada no Supabase

`arkhen_home_library(p_provider_key, p_scope_hash, p_include_adult, p_hidden_categories, p_hidden_items)` compõe o resumo privado da home no PostgreSQL. A RPC é somente leitura e `SECURITY INVOKER`. A identidade vem de `auth.uid()`; provedor e partição são conferidos no perfil autorizado. A rota local é `POST /api/home/library`.

| Campo | Significado |
| --- | --- |
| `counts.live/movie/series` | Favoritos ativos do próprio usuário, incluindo favoritos cujo item ainda não está no catálogo atual; respeita ocultações e adulto |
| `history.live/movie/series` | Até 30 títulos não adultos por tipo, ordenados pelo último progresso persistido; vários episódios da mesma série produzem um título na prateleira |
| `favoriteChannels` | Até 30 canais favoritos visíveis do próprio usuário |
| `recommendations.items` | Até 30 filmes/séries não adultos com nota de 7 a 10, deduplicados e intercalados por tipo |
| `recommendations.personalized` | Indica se os resultados efetivamente usaram sinais de gêneros assistidos |
| `revisionLibrary` | Última alteração persistida de favoritos ou progresso, incluindo remoções |
| `revisions` | Gerações publicadas dos três domínios; não é uma revisão global da biblioteca |
| `generatedAt` | Horário da consulta; não altera as revisões nem inicia coleta |

O histórico considerado pertence ao provedor atual e ao usuário autenticado. Um registro de progresso com episódio divergente, item divergente, remoção ou tempo inválido não entra no ranking. Cada título assistido contribui uma vez, com peso por recência dividido entre seus gêneros reais. O ranking preserva nota, ano, ordem de origem e alternância entre filmes e séries. Títulos já assistidos são excluídos por ID e identidade normalizada, incluindo variações de qualidade/áudio e alterações de ID do provedor.

O desbloqueio por PIN permite acesso explícito ao catálogo e aos favoritos adultos; não permite registrar sua reprodução. A home usa uma projeção independente, sempre sem adulto, para histórico, sinais de gêneros e recomendações. A política completa e a verificação do banco estão em [privacidade de reprodução adulta](adult-progress-privacy.md).

As contagens privadas começam nos favoritos, sem usar a lista global como prova de propriedade. Os metadados exibidos em recomendações, histórico e canais vêm somente da geração publicada e visível; filtros adultos e ocultações são aplicados antes da composição. Nenhum identificador de usuário, registro privado bruto ou credencial é retornado.

## Preparação compartilhada e desempenho

Os campos `query_*` da migração de navegação fornecem nota, ano e gêneros sem abrir o JSON completo do catálogo durante o ranking. A identidade `home_identity` é derivada na publicação por trigger. O preenchimento de gerações existentes usa lotes de até 1.000 linhas, chave completa com geração, índice parcial, `SKIP LOCKED` e lock de transação; apenas o serviço pode executar esse preenchimento. O agendador verifica pendências a cada minuto.

Se a geração atual ainda possui identidades pendentes, a RPC retorna `null`. A interface deve conservar a última home válida e aguardar a preparação. A publicação de um novo catálogo já preenche a identidade antes de tornar a geração visível.

O JSON de metadados é lido somente para a união dos resultados finais, limitada a 150 itens: 90 de histórico, 30 canais e 30 recomendações. O ranking usa campos compactos; não reprocessa os JSON de todos os filmes e séries. O primeiro lote real de 1.000 identidades levou 6.317 ms; isso é uma operação inicial do serviço, não o tempo de leitura da home. O preenchimento terminou com zero pendências antes do teste autenticado.

A medição por fases encontrou uma estimativa de uma linha para 26.988 itens visíveis. O plano escolhia loops repetidos entre as CTEs e a seleção dos 30 recomendados demorava 10.510 ms, antes de ler seus metadados. A migração `20261015170123_arkhen_home_query_plan.sql` configura `enable_nestloop=off` e `jit=off` somente em `arkhen_home_library`. A primeira opção desencoraja loops quando existe alternativa; a segunda evita a compilação disparada pelo custo artificial de loops inevitáveis. Nenhuma configuração global, limite de tempo, política RLS ou permissão foi ampliada.

Com as opções locais, a fase completa até o JSON levou 1.162 ms. As leituras reais pela API com JWT levaram 5.060 ms na primeira consulta e 1.316 ms na seguinte. São medidas deste ambiente e conta, não um benchmark de TV. Estatísticas mais precisas ou uma reescrita futura do plano podem ser avaliadas separadamente, preservando os mesmos testes de isolamento e paridade.

## Cache e interação

A resposta pertence à conta. A chave de cache inclui conta, revisões dos catálogos, revisão da biblioteca e filtros privados; não compartilhar esse cache entre usuários. Favoritos e progresso ainda pendentes de confirmação mantêm seu overlay local. Resposta antiga, falha ou troca de conta não pode sobrescrever uma edição mais recente.

Invalidar a home por mudanças relevantes de biblioteca ou publicação de catálogo; agrupar eventos Realtime e recarregar quando a home for usada. Não executar essa RPC em cada `timeupdate`, mudança de buffer, quadro ou foco do controle remoto. Percentual, seek e janela ativa de abertura continuam imediatos no dispositivo. Para conteúdo não adulto, o progresso permanece persistido em intervalos e em pausa/saída.

## Validação

As migrações `20261015164721`, `20261015170123`, `20261015171124` e `20261015172532` foram aplicadas e registradas no projeto autorizado. A sessão temporária usada para verificar a API foi revogada ao final.

`tools/test-home-library.mjs` executa as migrações reais em PostgreSQL/PGlite. As 63 asserções cobrem conta vazia, contas distintas na mesma partição, outra partição, permissões, autorização expirada, filtros, tombstones, favorito ausente do catálogo, deduplicação, paridade do ranking, limite por prateleira, preparação em lotes e preservação de estado desconhecido antes do término da preparação. Também cobrem recusa de progresso adulto por coluna, categoria e metadados de item/episódio; limpeza limitada; favorito preservado; ausência de sinais adultos após desbloqueio; exceção Adult Swim e IDs antigos não classificados.

Referência: [PostgreSQL — métodos do planejador](https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-ENABLE-NESTLOOP).
