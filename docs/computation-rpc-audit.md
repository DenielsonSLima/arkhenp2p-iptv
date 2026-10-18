# Cálculos de catálogo e biblioteca no Supabase

Auditoria de 15/10/2026. As observações de código abaixo são uma análise estática; não representam um benchmark de TV. As medições reais desta frente estão em `marker-sync-registry.md` e `home-library-rpc.md`. A busca e o modelo de navegação pertencem à frente de catálogo/UI; este documento distingue a implementação de backend das validações de integração e visual.

## Separação dos cálculos

| Caminho atual | Custo observado no código | Destino e isolamento |
| --- | --- | --- |
| `web/catalog-genres.js`, `web/app.js:categoriesFor` | Extração de gêneros, associação de categorias e contagens sobre todo o domínio | Modelo publicado no Supabase por provedor, partição, tipo, geração e inclusão de adulto; categorias e gêneros próprios de Filmes/Séries/TV |
| `web/catalog-sort.js` | Normaliza valores e ordena todos os itens a cada seleção | Ordens de IDs preparadas no servidor por geração; filtros privados selecionam desses IDs sem repetir ordenação completa |
| `web/home-sections.js:latestReleases` e `featuredTitles` | Ordenação e deduplicação de lançamentos repetida para prateleiras e destaque | `orders.releases` e `featured` preparados no modelo de cada domínio; metadados vêm do catálogo completo em cache |
| `web/home-recommendations.js:homeRecommendations` | Recria gêneros, identidades e ranking de todos os filmes e séries em cada montagem da home | RPC privada de home com sinais de histórico do próprio usuário e candidatos globais previamente normalizados |
| `web/home-sections.js:watched` | Cria mapa do catálogo inteiro para enriquecer um histórico pequeno | RPC privada limitada aos itens assistidos, enriquecidos por join indexado com a geração publicada |
| `web/library-selectors.js:selectLibraryFavorites` | Percorre somente favoritos privados e resolve metadados pelo mapa do catálogo | Manter resposta otimista local; contagens persistidas e leitura entre dispositivos vêm do Supabase, sem depender da disponibilidade do catálogo |
| `web/cloud-library.js:flushProgress` | Persiste as alterações acumuladas com outbox e revisão por registro | Banco continua autoridade; eventual RPC de gravação deve ser em lote, mantendo merge/revisão e confirmação por registro |
| `web/player/orquestrador.js`, `web/serie/progresso.js` | Percentual de reprodução, intervalo ativo, controles, seek e buffer | Permanecem no dispositivo; o Supabase fornece referências e persiste progresso em intervalos, pausa e saída |

Os metadados compartilhados não incluem favoritos, tempo assistido, coleções, categorias ocultas nem sinais de recomendação de uma conta. O cache completo diário continua separado por domínio e partição; as ordens e associações preparadas são publicadas junto da geração correspondente. Uma falha de atualização conserva a última geração completa.

## Contrato implementado para a home privada

`arkhen_home_library(p_provider_key, p_scope_hash, p_include_adult, p_hidden_categories, p_hidden_items)` foi implementada, implantada e testada com JWT real como `SECURITY INVOKER`, com usuário derivado exclusivamente de `auth.uid()` e autorização da partição. A RPC não recebe um identificador arbitrário de usuário.

A resposta contém `schemaVersion`, revisões dos três catálogos, revisão da biblioteca, `generatedAt`, contagens de favoritos por domínio e prateleiras limitadas a 30 itens. Cada prateleira retorna IDs e metadados seguros somente quando necessários. Histórico e favoritos partem das tabelas privadas; um join ausente no catálogo não apaga a contagem de um favorito salvo. O progresso usa a chave completa usuário/item/episódio, nunca apenas a série.

O ranking personalizado agrega os gêneros dos títulos realmente assistidos, deduplica variações de qualidade/áudio e pontua candidatos normalizados da geração visível. Sem histórico suficiente, usa nota e ano dos títulos atuais. O retorno indica `personalized` conforme os sinais realmente usados. Não armazenar essa resposta em um cache global por provedor; a chave inclui conta, revisões da biblioteca/catálogos e filtros privados.

A interface conserva um overlay de alterações locais ainda não confirmadas: favorito recém-marcado, item removido e progresso mais recente não podem regredir por uma resposta atrasada. Troca de conta cancela consultas e invalida o cache privado anterior. Eventos Realtime de progresso invalidam somente a projeção privada relevante; não recarregam Filmes/Séries/TV nem executam a consulta global de busca.

## Paridade antes de substituir seletores

As regras atuais de lançamentos ordenam ano de lançamento, categoria de lançamento, data de inclusão e ordem estável do provedor. Depois deduplicam título normalizado/ano, removendo sufixos de qualidade. O destaque seleciona entre os 36 lançamentos recentes, prioriza o intervalo do ano mais novo e exige imagens e nota para a preferência; completa com lançamentos quando faltam candidatos. O servidor deve retornar candidatos de reserva, pois categorias/títulos ocultos podem eliminar os três primeiros itens.

Datas ISO e timestamps numéricos precisam produzir a mesma ordem. IDs iguais em tipos distintos devem continuar distintos. Gêneros são derivados de metadados reais e categorias reconhecidas, sem transformar nomes de plataformas ou coleções em gêneros inventados. Filtros de categoria personalizados continuam privados. O desbloqueio adulto mantém o contrato de PIN existente; não é equivalente a conceder um novo papel administrativo no Supabase.

## Etapas e critérios de conclusão

1. **Registro de sincronização: concluído nesta frente.** A agregação de 97.370 linhas saiu da leitura. O resumo transacional roda a cada cinco minutos e a leitura autenticada medida caiu de timeout para 894 ms. Antes da primeira publicação retorna cobertura desconhecida, não zero.
2. **Busca e navegação global: implementação na frente de catálogo/UI.** Buscar a partir de três caracteres, resultado limitado e cancelável, contagens e classificação no Supabase. Preparar categorias, gêneros, ordens, lançamentos e destaque por geração. Verificar paridade, RLS, isolamento de domínio e consumo efetivo pelo cliente antes de declarar entregue.
3. **Home privada: backend concluído e integração acompanhada pela frente de UI.** RPC com índices privados, campos globais compactos e metadados limitados aos resultados finais. Foram validados dois usuários, favorito ausente do catálogo, episódios diferentes, tombstones, filtros, ranking e preparação; 35 asserções SQL passaram. A leitura real com JWT levou 5.060 ms inicialmente e 1.316 ms na seguinte. Resposta atrasada, conta trocada e modo offline também devem permanecer cobertos pela integração do cliente.
4. **Gravação privada: mudança somente se a medição justificar.** O código atual já limita progresso local a cinco segundos e mantém outbox. Validar merge, ordem e rejeição de conta antes de substituir gravações por uma RPC de lote. A pausa/saída força o envio quando a conexão permite.

Não fazer chamadas remotas em cada `timeupdate`, quadro, mudança de buffer ou foco do controle remoto. Transferir o trabalho compartilhável para o Supabase reduz CPU repetida; manter feedback imediato no dispositivo evita introduzir latência de rede na reprodução.
