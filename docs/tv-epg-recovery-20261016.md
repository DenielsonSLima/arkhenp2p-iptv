# Recuperação da programação de TV

Data: 16/10/2026. Escopo: backend de EPG; sem reprodução, navegador, novo login WPLAY, escrita SQL ou alteração de Filmes/Séries.

## Causa demonstrada e limite da atribuição

A modularização passou `/api/epg` a consumir a mesma projeção global de `/api/tv/guide`. O conector anterior retornava `null` antes de qualquer leitura quando `state.cloud.session.access_token` estivesse ausente, mesmo com uma sessão WPLAY válida. Assim, um bootstrap cloud pendente ou indisponível bloqueava também os metadados do provedor. Uma resposta RPC com `schemaVersion:1` era aceita sem avaliar se continha programação útil; a alternativa legada só era tentada após falha da RPC. Não havia recuperação WPLAY nessa rota.

Havia ainda uma renovação de login no caminho dos metadados: o guard comum de `app-server.mjs` chamava `client.connect()` em cada polling EPG; `WplayProviderClient.connect()` volta a autenticar depois de cinco minutos. A integração EPG agora valida a sessão já aberta, mantendo status, expiração e o limite de 24h da prova anterior, sem iniciar login por causa de uma atualização de programação.

As leituras administrativas agregadas foram feitas pelo wrapper fixado ao projeto `wnicimkmzswksaqdtgdv`, em transações somente leitura, sem payloads de conta, títulos, credenciais ou IDs de usuários:

| Instante UTC | Evidência remota agregada |
| --- | --- |
| 03:45:46 | Registry: uma partição legada, 760 canais, zero programas certificados como captura nova e horizonte nulo. Nenhum candidato de snapshot; uma fonte cifrada existente, nenhuma vigente. Job EPG com `CACHE_LEASE_LOST`; três falhas `lease_exhausted`. Os caches antigos contêm 760 linhas e 46.300 programas. |
| 03:51:38 | Os caches ainda possuem 666 canais com programa vigente e 23.779 programas futuros; horizonte até 19/10/2026 07:00 UTC. O catálogo live publicado possui 760 itens ativos. |
| 03:55:22 | A projeção armazenada sem adulto possui 659 canais, 565 com `window.current`; com adulto, 760 canais e 666 atuais. O catálogo de compatibilidade está completo, com 760 itens e 39 categorias. A função de grade concede execução a `service_role`. |

Portanto, o pipeline ainda não publicou sua primeira captura nova, mas isso **não equivale à ausência de programação**: há dados e janelas atuais calculadas no banco. A tela inteira vazia não pode ser atribuída somente à expiração dos caches. O bloqueio de dependência cloud no código é concreto. A revisão independente do frontend encontrou também que a mudança de escopo durante bootstrap limpava requisição/timer sem reiniciar os assinantes já montados em `TVGuideClient.synchronizeScope`; a correção pertence ao agente do frontend. A causa estática conjunta é compatível com os dados presentes no banco, sem certificar a última resposta recebida pelo usuário. Nenhuma leitura da aplicação do usuário foi simulada. Uma consulta diagnóstica intermediária atingiu o prazo HTTP de 15s; a consulta posterior foi reduzida e concluiu. Não houve chamadas da RPC de grade por SQL, pois ela também atualiza sua projeção.

## Recuperação implementada

`lib/tv/grade-provedor.mjs` contém `TvGuideProvider` e `readWplayLiveCatalog`. A recuperação usa exclusivamente `authInfo.service.epg_url` e, se necessário, `ch_url`, ambos já entregues pela autenticação existente. Não chama `connect()`, `authenticate()`, player, engine ou API de mídia. `enabledLive:false`, conta inativa/vencida e prova de autenticação fora de 24h impedem esse caminho.

Uma captura EPG completa é compartilhada entre leitores por provedor/escopo durante seis horas. A primeira leitura baixa o arquivo global uma vez; cards e canais não geram requests separados. Requisições concorrentes compartilham a mesma promise. O cálculo de anterior/agora/próximo ocorre no backend com `projectTvGuide`; a passagem de minuto ou programa recalcula a projeção sem baixar outro arquivo. Cada resposta usa o catálogo autorizado da conta e seu estado atual de PIN. A associação é `epgSameAs > 0 ? epgSameAs : chid`, conservando o ID público nativo de cada canal.

As leituras central e do provedor são iniciadas em paralelo, para não somar RPC de 3s, alternativa legada de 4s e arquivo WPLAY de 8s antes de responder ao cliente, cujo prazo de guia é 10s. A primeira projeção útil pode ser entregue, inclusive legada/desatualizada com programas ainda vigentes; suas flags permanecem verdadeiras. A outra promise permanece observada e compartilhada, para a atualização seguinte aproveitar a recuperação. Falha conserva metadados anteriores em vez de fabricar programação ou renovar sua idade.

O novo caminho independe de bootstrap, JWT cloud, fonte cifrada Edge, cron, lease ou publicação SQL. As leituras Supabase existentes conservam seus headers/RLS e seus limites de epoch. Logout, mudança de cliente/geração Auth, conta inválida, mudança de PIN e encerramento do runtime impedem a entrega de retornos antigos. O cache compartilhado contém somente programação sanitizada; tokens e endereços não entram no DTO, na revisão ou nos diagnósticos.

## Parcialidade e publicação

`parseWplayEPG()` devolve `{guides,coverage}`; `normalizeWplayEPG()` mantém seu retorno anterior `Map`. A cobertura conta registros de canal/programa inválidos e conserva canais explicitamente recebidos com `epg:[]`. Um canal ausente na resposta é diferente de uma lista vazia declarada pelo provedor.

Uma captura parcial não substitui uma captura anterior íntegra. Na primeira captura, programas válidos podem ser exibidos com `partial:true`; registros inválidos têm nova tentativa limitada por 30s. A projeção também identifica parcialidade quando falta associação para um canal autorizado. Captura vazia ou sem horizonte futuro não substitui a anterior.

O worker WPLAY passou a montar todos os canais a partir de um único arquivo global, sem chamar `client.epg(id)` para cada canal. Publicação exige cobertura explícita dos IDs associados e parse sem registros inválidos; ausência não é publicada como vazio confirmado. As RPCs de candidato selado/publicação atômica continuam preservadas.

O SQL existente aceita `p_fetched_at` com idade máxima de 15min. Por isso o worker não pode publicar uma captura de leitor com seis horas de idade nem trocar seu timestamp por `now`. Quando um job central realmente precisa de captura, ele obtém um arquivo integral recente com o token existente, separado do cache de leitores. Isso admite um GET integral adicional do job na cadência central já existente; não é um GET por canal. Não foi alterado ou executado SQL para ampliar esse limite.

## Interfaces e diagnóstico

```js
const providerGuide = new TvGuideProvider({now, maxEntries, onStatus});
providerGuide.capture({client, providerKey, scopeHash});
providerGuide.get({client, providerKey, scopeHash, ids, includeAdult, timeZone, current});
providerGuide.close();

readWplayLiveCatalog(client, {current, fresh, now});
wplayEPGSnapshot(client, {signal, cacheMs, now, force});
wplayEPGChannelID(rawChannel, publicChannelId);
```

As rotas e o DTO público permanecem: `schemaVersion:1`, `channels[id].window`, `list` de até três programas, progresso e horários calculados no servidor. A origem recuperada identifica `source:'wplay-epg'`, `legacySnapshot:false`, `partial` verdadeiro quando necessário, revisão por conteúdo e `snapshotFetchedAt/snapshotExpiresAt/sourceNextRefreshAt` reais.

O callback `onStatus` emite somente `{phase:'provider-epg',state,channels?,programs?,invalidChannels?,invalidPrograms?,durationMs,code?}`. `CloudRuntime.epgStatus` conserva o último diagnóstico. Códigos incluem `WPLAY_EPG_EMPTY`, `WPLAY_EPG_PARTIAL`, `WPLAY_EPG_SOURCE_CANCELLED`, `CACHE_EPG_COVERAGE_INCOMPLETE` e `CACHE_EPG_SOURCE_UNAVAILABLE`. Não há dados de conta ou URLs nesses eventos.

## Evidência APK e verificação

O contrato histórico de [`Spark.K`, parser e associação EPG](../analysis/WPLAYP2P-11.9.0d-epg-contract.md), para o SHA original, demonstra um GET de `epg_url` sem parâmetro de canal, token `t=`, User-Agent Android e metadados independentes da engine. Os horários no wire são strings ISO; os `Long` do modelo representam o resultado do parser. A [inspeção atual com REA/JADX](tv-backend-modules-20261016.md) confirma os campos de `EpgBeans/EpgBean`; métodos protegidos sem corpo Java não foram inventados ou executados. Não se derivou endpoint novo de um nome de classe ou URI P2P.

Foram feitas checagens de sintaxe dos módulos, revisão estática e bundle esbuild do backend para diretório temporário; o bundle não foi executado. As leituras remotas acima comprovam somente o estado observado do banco. Nenhuma requisição WPLAY, teste automatizado, UI, reprodução, novo login, instalação de runtime, restart, escrita SQL ou deploy foi realizado nesta correção. A execução da recuperação na sessão real continua reservada à validação do usuário.


Ativação pelo orquestrador principal: servidor local reiniciado com este código,
HTTP200 na página inicial. A conferência HTTP não acessou sessão/grade/mídia;
a confirmação visual da programação continua com o usuário.
