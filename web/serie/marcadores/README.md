# Leitura de marcações de Séries

`orquestrador.js` implementa `EpisodeMarkerReader`: consulta o manifesto autorizado da nuvem, depois os derivados abertos e os manifests locais. Conflito verificado não é ocultado por fallback; janelas de fontes distintas não são combinadas. O catálogo de validação/edições e os assets públicos permanecem em `web/series-markers/`, mantendo as URLs existentes.

`supabase.js` adapta somente as leituras `markerManifest` e `markerSeriesIdentity` da `CloudLibrary` já autenticada, com espera limitada e namespace de conta. Não cria cliente Supabase, Auth, sessão WPLAY, cache global de usuário nem requisição de mídia.

Troca de conta, AbortSignal e geração do episódio continuam revogando resultados tardios. Duração sem identidade de edição não habilita um salto. A duração de apresentação pertence a `web/serie/duracao.js`; o total medido vem do vídeo atual.
