# Recomendações de Filmes: custo e processamento por fases

Data: 16/10/2026. Estado desta frente: nova migration local preparada e revisada, sem aplicação remota. O integrador controla o rollout do banco/backend/cliente. Não houve execução de ranking, autenticação, impersonação, leitura de biblioteca pessoal, teste ou mídia nesta frente.

Atualização do integrador: esta migration e a consulta compacta da Home foram instaladas e conferidas no projeto autorizado. Funções/índices/permissões e marcadores do corpo foram lidos novamente. O limite HTTP das duas projeções é10s sobre SQL8s e o cliente de Filmes12s. Diagnóstico real e limites da publicação em [503 de Home/Filmes](movies-recommendations-503-20261016.md).

Atualização posterior: a045808 abaixo ainda cancelava em SQL8s. O LIMIT aplicado depois do classificador não limitava o trabalho amplo; os GIN não eram elegíveis nesse caminho sob RLS. A51752 publicada substitui a seleção por mapa global preparado e usa `byId` na RPC. As seções abaixo documentam a etapa anterior; o [diagnóstico atualizado](movies-recommendations-503-20261016.md) contém a causa adicional, a tentativa revertida e o readback final.

## Causa comprovada do prazo excedido

Uma nova ação real do usuário produziu `RPC_REQUEST_FAILED / CLOUD_TIMEOUT` em aproximadamente 3.002ms para Filmes e 3.003ms para Home. O integrador leu métricas agregadas do banco, sem parâmetros: a chamada Movie levou 6.528,2ms e retornou uma linha; Home teve média de cerca de4,7s e máximos próximos de8s. O orçamento HTTP anterior de3s interrompia a espera antes de a resposta SQL chegar.

A leitura global anterior já havia confirmado navegação pronta, zero identidades pendentes e dependências/tipos presentes. Não foi atribuído esse caso a bootstrap/JWT ou DTO inválido. O integrador coordenou prazo HTTP de10s com cliente de12s, preservando SQL8s. Essa correção de orçamentos é separada da otimização abaixo; o prazo SQL não foi aumentado.

No SQL anterior, materializações de afinidade/categorias/ordem expandiam associações de milhares de IDs e eram necessárias também quando a origem já tinha dez candidatos fortes. O join dos candidatos com afinidade impedia um retorno forte independente. Isso é custo demonstrável na estrutura; a parcela exata de cada operador não foi medida.

## Nova migration e contratos

`20261016045808_arkhen_movie_recommendations_bounded_phases.sql` foi criada pela CLI após a ajuda do comando. Mantém nome/assinatura da RPC, schemaVersion1, rankingVersion2, sourceRPC, limite10 e orçamento SQL8s. Adota identityVersion2, coordenada pelo integrador com conector e cliente para impedir rejeição de versão no rollout.

O processamento passa a:

1. Buscar somente franquia/universo pelos índices de identidade e retornar imediatamente se os filtros finais deixam dez obras válidas. Não carrega o navigation payload nem calcula afinidade de histórico nesse caminho.
2. Se faltarem itens, buscar contexto pelos arrays compactos query_genres/category_ids. Carrega somente contagens de gêneros do navigation para especificidade; não expande orders/itemIds.
3. Somente se ainda faltarem itens, obter pesos de até100 títulos recentes do proprietário e candidatos de gênero do histórico.

Os vistos de Filmes continuam excluídos em todas as fases, inclusive por obra/edição, sem limitar a política aos100 sinais recentes. Esse filtro particular não é um ranking global. Cada fase limita seu pool a600IDs; o acumulado é no máximo1.800. No máximo120 metadados completos são lidos por fase, até360 no pior caminho de três fases. Pode haver menos de dez resultados válidos; o limite não autoriza inventar itens nem ignorar filtros.

Franquia prevalece sobre universo, que prevalece sobre gênero/categoria/histórico. Nota/ordem estável desempata dentro dessas classes. O histórico não reranqueia as classes fortes; personalized só fica true quando um item da última classe foi de fato usado. A resposta mantém recommendationReason por item.

## Índices e aliases versionados

Novo GIN `arkhen_movie_query_genres_v3`, parcial para filmes ativos e nãoadultos. O caminho de contexto reutiliza o GIN existente de category_ids. Não há coluna gerada nova, alteração de políticas, cron, cache pessoal global ou atualização de linhas privadas.

O helper `arkhen_movie_recommendation_keys_v2` adiciona frases qualificadas Senhor dos Anéis/The Lord of the Rings e O/The Hobbit, com famílias próprias e universo editorial middle-earth. A associação é sustentada pelo [catálogo oficial de filmes de Middle-earth](https://www.middleearth.com/films). Não usa nomes de ator, sinopse, palavras isoladas como anel ou gênero para afirmar franquia.

O novo índice GIN `arkhen_movie_recommendation_keys_v2` materializa a expressão nova. O helper/índice versão1 já aplicado permanece intacto para compatibilidade, evitando modificar uma função imutável atrás de valores de índice antigos. O custo de manter dois índices de identidade é explícito; eventual retirada do índice antigo exige confirmar consumidores e uma mudança própria.

Avatar/Aang e Cameron mantêm as regras anteriores e a exclusão mútua antes do shortlist, inclusive no preenchimento por gênero. IDs nativos, RLS, auth.uid, partição, geração visível, ocultações, adulto, vistos e dedupe de obra continuam revalidados no destino limitado.

## Verificações e limites da evidência

Revisão independente do pipeline não encontrou bloqueador concreto de SQL/tipos/RLS/ordem/dedupe. Foi solicitada revisão específica do classificador novo. A frente também revisou somente por leitura a proposta de Home do outro responsável, sem editar esse domínio.

Oito SELECTs da proposta passaram no parser/planner remoto por EXPLAIN semANALYZE, com identidade/partição/origem nulas e tipadas. Não houve chamada da RPC, JWT ou execução de linhas pessoais. Como helper/índice v2 ainda não estavam instalados, o artefato exclusivo de planejamento substituiu a chamada pelo helper versão1 de assinatura idêntica; isso não altera a migration e não certifica o plano real do índice novo. O último plano retornou71nós e nenhuma métricaActual.

Essas verificações não medem ganho real de latência. Gêneros amplos ainda podem alcançar muitos candidatos compactos, e os índices têm custo de criação/publicação. O ganho só poderá ser quantificado a partir de novas requisições autorizadas após o rollout e suas métricas agregadas, sem aumentar o limite SQL para esconder custo.
