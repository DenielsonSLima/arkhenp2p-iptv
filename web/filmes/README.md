# Filmes no navegador

Implementação canônica de navegação, metadados, prévia, recomendações e adaptadores da biblioteca de Filmes. `MoviesFeature` é a mesma aba usada pela aplicação; `configure()` agrega seus serviços sem criar outra feature, catálogo, sessão WPLAY ou cliente Auth.

| Arquivo | Responsabilidade |
| --- | --- |
| `orquestrador.js` | Compõe catálogo, serviços, modelo de recomendações existente, prévia e biblioteca. Reúne reset/dispose e os eventos já autenticados. |
| `services.js` | Mantém a carga de catálogo no repositório da conta; lê detalhes/duração e sugestões pelas rotas locais com deduplicação de leitores, cancelamento e cache de até 64 entradas de metadados. Constrói somente a URL local autenticada de reprodução. |
| `scope.js` | Conta, geração, partição, PIN e preferências de Filmes. Preferências exclusivas de TV/Séries não mudam essa identidade. |
| `previa.js`, `titulo.js`, `duracao.js` | Renderização da prévia, título/fatos e duração informada ou previamente medida. Não estimam a duração por tamanho de arquivo ou outro título. |
| `tanstack-query.js` | Um modelo TanStack para recomendações, compartilhado por prévia/fim; guarda conta, origem, revisão, ranking e cancelamento independente dos consumidores. |
| `recomendacoes/contrato.js` | Validação do DTO RPC: `schemaVersion:1`, `rankingVersion:2`, `identityVersion:2`, `source:'rpc'`, origem correspondente e até dez filmes distintos. |
| `recomendacoes/sessao.js` | Estado de cada destino, cancelamento de respostas antigas e retenção dos itens válidos na falha de atualização da mesma conta/origem. Não pontua nem reordena candidatos. |
| `recomendacoes/visualizacao.js` | Cards, prévia e tela de término real do filme. Ordem e vínculo vêm do servidor; nenhuma sugestão começa automaticamente. |
| `supabase.js` | Leitura filtrada da `CloudLibrary` existente. Escritas são delegadas aos callbacks do `CloudAppBridge`, inclusive enquanto o bootstrap está pendente. Não abre SDK, Auth ou socket próprios. |
| `favoritos.js` | Altera uma vez o mapa `movie:<id>` da conta, publica a projeção TanStack e solicita uma única escrita pela ponte. Reconciliação remota não grava novamente. |
| `progresso.js` | Leitura e gravação de progresso medido do filme na biblioteca existente. O player fornece a posição autorizada; uma chamada de salvar dispara uma chamada à ponte. |
| `realtime.js` | Consome revisões de catálogo `movies` e alterações privadas `movie`. Uma posição salva não recarrega o catálogo nem dispara sugestões a cada cinco segundos. |
| `audio.js`, `legenda.js`, `resolucao.js`, `buffer.js`, `reproducao.js` | Políticas específicas do filme sobre o vídeo e controladores compartilhados. Consulte o [mapa do player de Filmes](../../docs/movies-player-modularization-20261016.md). |

## Composição e manutenção

Use `configure({request,getScope,getSession,cloudLibrary,recommendationsModel,...})` depois de criar configurações e a ponte da biblioteca, antes de iniciar login/restauração. O modelo existente é reutilizado; não instancie outra query de recomendações para a prévia ou a tela final. `createSuggestions()` pode construir o DOM antes dessa configuração porque sua consulta é avaliada somente ao selecionar um filme.

`renderPreview()` e `updateDuration()` compõem as implementações de apresentação. `services.details(item,{duration,signal})` não abre o player; somente o título selecionado pode pedir a leitura opcional de duração. Um cancelamento da prévia não cancela outro leitor ainda ativo dos mesmos metadados.

`favoritesStore.toggle()` e `progress.salvar()` atualizam os mapas existentes e delegam aos callbacks `saveFavorite`/`saveProgress` da ponte. Seus callbacks locais persistem/apresentam a mudança; eles não devem realizar uma segunda gravação na nuvem. A integração do player usa `MoviePlayback.progress()` → `progress.salvar()` uma vez. A política de mídia pronta, posição autorizada e intervalo de cinco segundos pertence ao controlador de reprodução, sem duplicar seu relógio no adaptador da biblioteca.

## Recomendações de dez filmes

Todo ranking pertence à RPC, incluindo franquia, universo e gênero. Não há fallback de ranking do catálogo no navegador. Falha mantém a última seleção válida da mesma conta/origem e mostra uma ação de tentar novamente; ausência legítima não é preenchida com filmes aleatórios. Cada card pode apresentar `recommendationReason` recebido da RPC, sem alegar que a lista inteira pertence à mesma franquia.

O callback `onCloudStatus(status,previous)` recupera uma seleção visível em erro quando a biblioteca passa de `connecting`, `offline`, `restricted` ou `local` para `synced`. É uma tentativa por transição, sem relógio ou repetição em cada render; sincronizações de progresso (`syncing` → `synced`) não refazem sugestões. A recuperação exige a mesma conta, geração, proteção parental e filtros de Filmes, preservando os cards válidos dessa seleção. O estado de falha guarda somente código, fase, status HTTP e eventual intervalo de espera sanitizados; mensagens de banco, payload e credenciais não entram no DOM.

A consulta de sugestões tem prazo externo padrão de 12 segundos, configurável entre 0,5 e 15 segundos. Esse prazo envolve a RPC com orçamento SQL de oito segundos e transporte do servidor de dez segundos; não altera timeouts de vídeo, detalhes, autenticação ou outros domínios. Uma recuperação usa `force` para revalidar o DTO em cache e conserva as guardas de conta/geração; não acrescenta tentativas automáticas.

`web/movie-suggestions.css` exibe cinco colunas no desktop e quatro, três ou duas conforme a largura, com até dez cards e capas proporcionais. A interface preserva a ordem fornecida pelo servidor. A disponibilidade de dez opções depende dos candidatos elegíveis da RPC.

O contrato de ranking 2 e identidade 2 precisa estar aplicado no banco para ser aceito pelo cliente. Ambas as versões fazem parte da chave TanStack; respostas com identidade 1 são rejeitadas e não servem de fallback. Sintaxe/bundle local não comprovam essa instalação; a confirmação remota pertence ao relatório da aplicação da migration. Nenhum teste, navegador ou reprodução foi executado nesta etapa.

As antigas fachadas `movie-preview.js`, `movie-recommendations-model.js`, `movie-suggestions.js`, `local-movie-recommendations.js` e `related-movies.js` foram retiradas após migrar seus consumidores. O seletor antigo de relacionados permanece apenas como fixture histórica em `tests/fixtures/related-movies-legacy.mjs`; não é servido pelo grafo da aplicação.

O transporte de mídia, Range, stop/status e a sessão continuam compartilhados no servidor. Esta extração do navegador não afirma que o backend de Filmes inteiro foi migrado para `lib/filmes/`, nem comprova reprodução real. Veja o [mapa do sistema](../../docs/system-modularization-20261016.md).
