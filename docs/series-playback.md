# Reprodução de séries

`SeriesPlaybackPreferences` é uma única instância compartilhada por Configurações e `EpisodeSkipController`. Os padrões são `autoNext: true`, `autoSkipOpening: true`, `nextMode: 'markers'` e `endOffsetSeconds: 30`. Sem créditos verificados/manuais, o padrão aguarda o evento real `ended`; o valor de 30 segundos só participa quando o modo `offset` foi selecionado ou já estava salvo. Preferências antigas são preservadas. A interface mantém uma cópia local por conta e o `CloudAppBridge` sincroniza a preferência `series-playback` no Supabase quando conectado. `getPreferences()`, `setPreferences(patch)` e `subscribe(listener)` atualizam a interface sem recriar seus controles. A rota é `#settings/series-playback`.

## Passagem para o próximo episódio

- **Antes do fim:** usa os créditos marcados para a edição atual do episódio. Sem marcação, inicia uma contagem de 5 segundos quando faltarem os 30 segundos configurados. É um horário aproximado, exibido dessa forma na interface, e pode incluir cenas. Não é detecção de créditos. O intervalo pode ser alterado de 5 a 300 segundos. Vídeos mais curtos que o intervalo mais a contagem aguardam seu término.
- **Somente créditos marcados:** antecipa apenas com uma marcação válida. Na ausência dela, aguarda o vídeo terminar.
- **Quando terminar:** preserva o episódio inteiro, inclusive créditos, antes de iniciar a contagem.

A contagem permite reproduzir imediatamente ou cancelar para este episódio. Pausa, buffering e seek suspendem o relógio. `seeked` sozinho não confirma que a decodificação voltou: o relógio aguarda `playing`, dados decodificados (`readyState >= 2`) e o fim do seek. Cancelar continua valendo até voltar para antes do ponto de disparo ou abrir novamente o episódio. Alterar outra preferência não desfaz o cancelamento. Só existe um avanço automático por sessão do episódio; `ended` repetido não dispara um segundo avanço. O último episódio não oferece reprodução automática de outro título.

Uma política verificada e vinculada à edição com `verification.blockEarlyNext: true` informa que pode haver prévia, cena pós-créditos ou final ambíguo. O player mostra “preservar conteúdo final” e aguarda `ended`, inclusive se houver offset configurado. O resolvedor pode entregar essa política com `markers: {}`, sem inventar janelas. Identidade, episódio, prova de edição/fonte e duração são obrigatórios. Créditos marcados manualmente pelo usuário têm prioridade; apagar essa marcação restaura a proteção. Referências comunitárias permanecem diagnósticas.

O callback recebe `onNextEpisode({automatic, reason: 'credits' | 'ended', approximate})`. Para a antecipação por intervalo, `reason` é `credits` e `approximate` é `true`; o texto na tela sempre informa que o horário é aproximado. O app usa `automatic` para registrar conclusão antes de trocar de episódio. Ações manuais retornam `automatic: false`.

## Abertura

Não há duração de abertura presumida. A janela pode vir do resolvedor de marcações da edição atual ou ser marcada pelo usuário no menu de ajustes do player para aquele episódio. Ao entrar numa janela válida, `autoSkipOpening` mostra **Pular abertura em 5s**, depois 4, 3, 2 e 1. O salto usa o mesmo controlador central de seek. O painel permite **Pular agora** ou **Cancelar**; não há salto imediato automático.

Pausa, buffering e seek suspendem o relógio. `seeked` sozinho não o retoma: é necessário `playing`, `readyState >= 2` e nenhum seek pendente. Entrar nos últimos menos de cinco segundos de uma abertura não cria uma contagem apressada; a ação manual permanece disponível. Sair da janela invalida sua contagem. Cancelar vale para a sessão atual do episódio, inclusive se entrar novamente no meio da abertura; voltar para antes do início ou reabrir o episódio permite uma nova oferta. Depois de um salto automático, voltar no vídeo permite assistir ao trecho sem saltos repetidos. Reset, troca de conta e troca de fonte invalidam timers e callbacks anteriores.

Desativar a preferência mantém o botão manual “Pular abertura”. A contagem fica visível mesmo quando os ajustes do player estão abertos; nesse caso, somente os botões manuais avulsos são ocultados. A abertura e o próximo episódio têm timers separados, e o próximo episódio não inicia uma contagem concorrente durante o painel da abertura.

### Contrato de marcações fornecidas

`EpisodeSkipController` recebe um callback opcional, síncrono ou assíncrono:

```js
getEpisodeMarkers({item, episode, duration, editionId, sourceFingerprint, signal})
// => Promise<{status: 'matched', mediaId, season, episode,
//     markers: {openingStart, openingEnd, creditsStart},
//     confidence: 'edition-verified', provenance}> | null
// O mesmo contrato vale para respostas síncronas. marks sem prova é rejeitado.
```

O resolvedor confere identidade, episódio, vínculo de edição/fonte e duração antes de devolver a janela. O controlador repete a verificação, incluindo `mediaId`, temporada e episódio, só após metadados válidos. Também valida ordem e limites dos tempos e ignora erro ou ausência de dados. Uma Promise é consultada uma única vez por fonte/duração; reset cancela seu signal e respostas antigas não atravessam fonte, conta ou duração. `matched` sem prova verificável não entrega marcadores ativos.

`EpisodeMarkerReader`, em `web/series-markers/reader.js`, prefere `CloudLibrary.markerManifest()`; na ausência de um episódio verificado compatível, verifica `/series-markers/open-data/<slug>/manifest.json` e depois os manifests locais originais. A espera pela nuvem é limitada a um segundo, e cada catálogo local tem prazo de quatro segundos. Referências comunitárias ficam apenas em diagnósticos, sem oferta manual ou automática. Não há interseção entre fontes. Conflitos entre registros verificados da mesma edição bloqueiam o resultado e não podem ser ocultados por um fallback antigo. Os limites e as fontes estão em [verificação no player](marker-playback-verification.md).

`web/series-markers/registry.js` centraliza as identidades pesquisadas e seus aliases exatos, usado tanto pelo importador de referências como pelo navegador. A nuvem não usa uma lista paralela de séries permitidas. Uma resposta parcial do banco não esconde um episódio local compatível: o leitor verifica o fallback com as mesmas regras, sem transformar uma referência comunitária em edição comprovada.

Uma atualização Realtime de `episode_skip_markers` limpa o leitor e chama `refreshExternalMarkers()`. Esse método cancela o trabalho importado e suas contagens, consulta os dados novos e preserva marcações manuais e a decisão de cancelar a abertura. O controlador não inventa durações nem transfere uma janela para outro episódio.

Marcações manuais daquele episódio têm prioridade. Um início manual sem fim suprime o par importado até que a marcação manual seja concluída, evitando misturar duas janelas. Créditos manuais também têm prioridade. Importações não são persistidas como escolhas do usuário; a ação explícita de marcar salva somente campos manuais. Marcar o fim com um início fornecido visível cria um par manual intencional. Apagar marcações manuais permite novamente a janela fornecida; para assistir à abertura, use Cancelar ou desative a preferência.

Os avanços usam o callback central `onSeek(target, {reason: 'opening' | 'credits'})`, que pode retornar boolean ou Promise. Sem callback, o módulo mantém a compatibilidade com a atribuição direta de `video.currentTime`.

## Conta, edição e persistência

O store v2 aceita IDs públicos numéricos ou opacos seguros (`A–Z`, `a–z`, `0–9`, `_`, `-`, até 160 caracteres). Marcações pertencem à combinação conta + série + episódio + fingerprint da fonte + duração exata. Outra fonte ou duração suprime a marcação anterior até que seja feita novamente.

Somente `account.libraryId` de 64 caracteres hexadecimais autoriza persistência no navegador. Identificadores temporários como `session_42`, ou namespace ausente, mantêm as marcações apenas na memória. O app fornece `getAccountNamespace: () => account.libraryId || session_generation`; trocar a conexão muda esse escopo. Reset de fonte mantém a memória do mesmo escopo. `clearSessionMarkers()` elimina os registros temporários se necessário. O limite é de 200 episódios; URLs, tokens e identificadores brutos da conta não são gravados.

Marcações antigas v1 não tinham conta associada e não são migradas automaticamente. O armazenamento bloqueado mantém os controles utilizáveis na sessão. Reset de player e mudança de namespace invalidam timers, seeks pendentes e callbacks antigos. O módulo espera os metadados da nova fonte antes de decidir qualquer avanço.

## Verificação

`node --test tests/episode-skip.test.mjs tests/series-playback.test.mjs tests/series-playback-preferences-view.test.mjs` cobre limites e persistência, conta/fonte/duração, ausência de abertura, janelas fornecidas e manuais, prioridade dos créditos, horário aproximado, as duas contagens de 5 segundos, pausa, buffering, cancelamento, entrada tardia na abertura, seek para trás, `ended` duplicado, troca de fonte e preferências em tempo real. A revisão de 15/10/2026 também verificou DOM real em Chromium isolado com mídia e relógio simulados, incluindo cliques nos controles, detalhes sob demanda e ausência de saltos comunitários. Evidências e limites estão em [verificação do player](marker-playback-verification.md).
