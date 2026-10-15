# Reprodução adulta sem histórico

Revisão de 15/10/2026. O desbloqueio parental permite reprodução durante a sessão; ele não permite registrar histórico, posição, episódios assistidos ou sinais de recomendação desse conteúdo. Favoritos permanecem uma ação explícita e separada.

## Classificação compartilhada

`web/parental-classification.js` é usado pelo navegador e pelo controle parental do servidor. Considera marca positiva `adult`, `isAdult` ou `is_adult`, categoria marcada associada por ID, nomes de grupo/categoria e marcadores explícitos no título. A marca Adult Swim é uma exceção de nome; números comuns de títulos não são classificação adulta. Uma marca negativa ou metadata posterior sem o campo não deve apagar uma classificação positiva já conhecida.

O servidor já usa PIN padrão `0000`, compara quatro dígitos e mantém o desbloqueio apenas na sessão. O navegador não deve usar `parentalControl.allows` para decidir persistência: quando desbloqueado, esse método permite reprodução. A decisão de registro é `canRemember(item)`, além do veto intrínseco do classificador.

## Entradas e leitores

| Caminho | Evento ou finalidade | Regra |
| --- | --- | --- |
| `app.js`: `saveLiveWatch` | Evento `playing` de TV | Nenhum registro adulto, mesmo desbloqueado. |
| `app.js`: `saveProgress` | `timeupdate`, pausa, término, fechar player, reinício e próximo episódio | Verificar item e episódio antes de alterar histórico, progresso local ou nuvem. |
| `app.js`: `pagehide` → `stopPlayback` | Saída da página | Aplica o mesmo bloqueio de gravação. |
| `app.js`: `historyFor`, cards, detalhes e `watchDetail` | Barra de progresso, continuar e seleção do último episódio | Histórico adulto não participa desses leitores. |
| `MediaLibrary` | Carregar/salvar biblioteca, migração e importação local | Filtrar e reconciliar progresso antigo; preservar favoritos. |
| `CloudLibrary` e outbox | Hidratação, Realtime, importação, progresso pendente e flush em `pagehide` | Bloquear registro e reenvio adulto; preservar a biblioteca da conta correta. |
| `CloudAppBridge` | `receive`, `syncLocal`, exportação de episódios | Os módulos de persistência vetam registros adultos; progresso local de episódios já reconciliado não entra na exportação. |
| `EpisodeProgressStore` | `save`, `seed`, `read`, `list`, armazenamento por conta | Veto intrínseco mais callback `canRemember`; reconciliação por ID remove registros antigos sem metadata. |
| `detailPlaybackProgress`, `episodePlaybackProgress` | Indicadores de progresso | Retornam `null` para item/episódio adulto ou snapshot antigo marcado. |
| `resumePlaybackPosition` | Abrir filme ou episódio | Retorna zero para histórico adulto; nunca consulta posição persistida nesse caso. |
| `continuedPlaybackPosition`, `PlaybackPositionGuard` | Seek e recuperação da fonte atual | Podem preservar posição apenas na memória do player em execução. |
| `cloudHomeSections`, `cloudFeaturedTitles` | Histórico, recomendações, lançamentos e hero | Excluem conteúdo adulto mesmo quando a sessão pode reproduzi-lo. |
| Supabase `user_progress` e RPC da home | Escrita/leitura direta ou cliente antigo | Guard por identidade e catálogo confiável, projeção segura e limpeza limitada; implementação na migração específica. |

## Contrato de episódios

```js
const episodes = new EpisodeProgressStore({read, save, canRemember});
episodes.setNamespace(accountLibraryId);
episodes.reconcileCatalog(catalog, 'series');
episodes.purge({kind: 'series', id: adultSeriesId});
```

`reconcileCatalog` aceita categorias e itens brutos ou preparados, incluindo `sourceCategories`, e retorna a quantidade de episódios removidos. Deve ser chamado quando a classificação do catálogo chega e antes da atualização visual/retomada. `purge` remove todos os episódios do título e impede que snapshots antigos o reinsiram durante essa sessão de conta. A troca de namespace limpa a classificação transitória, evitando aplicar IDs de outro provedor/conta. Nenhum nome, título, URL ou credencial é acrescentado ao armazenamento de episódios.

## Verificação interna

Os quatro arquivos de teste `episode-progress`, `detail-progress`, `playback-position` e `home-cloud-sections` passaram em conjunto: **40 testes**. Casos novos incluem categoria adulta com título sem `isAdult`, purga de dois episódios legados sem afetar série segura, seed duplicado, snapshot ou envelope antigo marcado, troca de conta, bloqueio com PIN liberado e manutenção de seek em RAM. Esses testes verificam módulos; a integração da UI e a migração SQL têm verificações próprias coordenadas pelo agente principal. A validação visual final permanece com o usuário.
