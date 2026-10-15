# Progresso por episódio

`web/episode-progress.js` mantém posições independentes por série e episódio. A biblioteca anterior guarda somente o último episódio de cada série e continua sendo usada para a seção “Continuar assistindo”. O novo store complementa essa biblioteca.

```js
const episodes = new EpisodeProgressStore({read, save});
episodes.setNamespace(session.account.libraryId || null);
episodes.save({item, episode, time:video.currentTime, duration:video.duration, completed:video.ended, updated:Date.now()});
const previous = episodes.read(item, episode);
renderSeriesPreview(tools, details, {
  readEpisodeProgress:(item, episode) => episodes.read(item, episode)
});
```

O namespace deve ser um identificador opaco, estável e específico de provedor, servidor e conta. Não use senha, URL, nome completo do usuário ou somente `usernameMasked`. A chave de armazenamento é `orbit.episode-progress.v1.<namespace>`. O envelope interno também precisa ter o mesmo namespace. Não há envio remoto nem sincronização entre dispositivos.

Sem namespace, o store funciona somente na memória da sessão. Cada chamada a `setNamespace(null)` limpa essa memória; faça isso ao sair ou trocar a conexão. Um namespace persistente diferente também substitui a memória ativa. O limite padrão é de 1.500 episódios por conta, mantendo os registros mais recentes; o limite configurável não ultrapassa 5.000. Falhas de storage não interrompem o player.

`save()` recebe tempos numéricos em segundos e retorna uma cópia do registro, ou `null` para identidade/tempo inválidos. `read()` retorna uma cópia ou `null`. `list(item?)` retorna cópias ordenadas pela última atualização. São guardados apenas IDs, posição, duração, conclusão e números de temporada/episódio. Fontes, títulos e referências de imagem não são persistidos. IDs opacos curtos são aceitos pelo store; as rotas e temporadas do aplicativo mantêm seu contrato público de IDs numéricos.

Salve o episódio atual **antes** de substituir `player.item`/`player.episode` ou remover a fonte. Os hooks de pausa, timeupdate, término e fechamento podem usar o mesmo método. A retomada deve preferir `read(item, episode)` do episódio escolhido; consultar só o histórico por série perde a posição dos demais episódios. Registros com atualização anterior não substituem um salvamento mais novo.

`seed(entries, {namespace})` migra somente posições ausentes e exige que o namespace informado seja exatamente o ativo. O chamador precisa comprovar a titularidade dos dados. O histórico antigo de `MediaLibrary` é separado apenas por provedor e **não deve ser migrado automaticamente** para uma conta. Como compatibilidade visual, o renderizador pode usar `historyEntry` somente quando série e episódio coincidirem; essa leitura não migra nem persiste dados.

`episodePlaybackProgress(item, episode, entry)` produz tempos, percentual e estado para a lista. Duração medida salva tem prioridade; depois, são aceitos `episode.durationSeconds` e duração com unidade ou relógio `HH:MM:SS` explícitos. Um número sem unidade em `episode.duration`, duração da série ou outro episódio nunca fornece o total. Sem total real não há barra percentual. Um episódio sem posição mostra `0:00 / total` quando há total real. `Assistido` é derivado de término explícito ou pelo menos 95% da duração conhecida, conforme o critério de retomada existente; novo progresso de uma reprodução reiniciada pode voltar a “Continuar assistindo”.

Linke `web/episode-progress.css` depois dos estilos de detalhes. O callback `readEpisodeProgress(item, episode)` é opcional e não faz requests. Cada linha mantém o botão original, informa o estado e os tempos em seu nome acessível e usa uma barra nativa com valores em segundos.

## Miniaturas

`episodeArtworkSources()` seleciona primeiro uma imagem explicitamente fornecida para o episódio (`thumbnail`, `still`, `image` ou `poster`). Os adaptadores WPLAY, OTT e Xtream registram as URLs de imagens recebidas em metadados no proxy autenticado; o navegador não recebe a URL original. O carregamento da miniatura é lazy e não abre nem captura a transmissão do episódio.

Quando falta uma imagem de episódio ou ela falha, a linha usa o backdrop/capa da série, com o rótulo **Imagem da série**. Sem nenhuma imagem válida, preserva o botão de play sobre um fundo neutro. O aplicativo não apresenta uma imagem da série como se fosse um frame daquele episódio. `web/title-preview.css` mantém as miniaturas 16:9 e adapta a linha em telas pequenas.
