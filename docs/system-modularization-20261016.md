# Organização do sistema — 16/10/2026

Estado: implementação local e revisão estática. Este registro não comprova publicação, estado remoto ou reprodução. Os testes e a conferência no navegador permanecem com o usuário.

Atualização posterior: a [revisão integrada WPLAY](architecture-review-wplay-20261016.md) registra a modularização completa de Séries, a conexão do provedor por domínio e a remoção das fachadas TV/player restantes. Nesta atualização houve testes sintéticos, sem navegador ou mídia real. As seções de etapas anteriores abaixo conservam seu contexto histórico.

## Implementações canônicas

`web/app.js` compõe os domínios, a sessão geral e o único elemento de vídeo. Ele injeta estado, transporte e ações; as extrações abaixo possuem implementação e ciclo de vida próprios.

| Domínio | Caminho | Responsabilidade real |
| --- | --- | --- |
| Login | `web/login/orquestrador.js` | Entrada/restauração, geração da conexão, cancelamento e passagem da sessão validada à aplicação. |
| Login | `web/login/services.js` | Rotas locais de login e sessão; não cria outra autenticação Supabase ou WPLAY. |
| Login | `web/login/tela.js`, `fundo.js`, `preparacao.js`, `capas.js` | Formulário, fundo, progresso de entrada e preparação de imagens, respectivamente. |
| Sistema | `web/sistema/orquestrador.js`, `services.js` | Composição do cabeçalho e transporte JSON autenticado pela sessão local existente. |
| Sistema | `web/sistema/cabecalho.js`, `navegacao.js`, `busca.js`, `conta/menu.js` | Validade informada pelo servidor, troca de domínio, intenções da busca e menu de conta. A busca não mantém outro catálogo. |
| Sistema | `web/sistema/hooks.js`, `ui/dom.js` | Registro e remoção de eventos/foco e construção de elementos/ícones reutilizáveis. |
| Configurações | `web/sistema/configuracoes/orquestrador.js`, `views.js` | Preferências, organização do catálogo e renderização das seções existentes. |
| Configurações | `web/sistema/configuracoes/audio.js`, `series.js`, `marker-sync.js` | Preferências de áudio, reprodução de séries e consulta do registro de marcadores. Reutilizam seus proprietários existentes. |
| Catálogo | `web/sistema/catalogo/aba.js`, `services.js`, `barra-lateral.js`, `visualizacao.js`, `realtime.js` | Estado da aba, IO por tipo, categorias, apresentação e releitura por revisão. O repositório de catálogo continua único por conta. |
| Início | `web/inicio/orquestrador.js` | Renderização das prateleiras, composição do banner/carrosséis e reset dos leitores do início. |
| Início | `web/inicio/services.js`, `tanstack-query.js`, `realtime.js` | Projeção privada `/api/home/library`, cache TanStack com orçamento/recuo e eventos da conexão autenticada já existente. |
| Início | `web/inicio/hooks.js`, `projecao.js`, `ordens.js`, `secoes.js`, `progresso.js` | Preparação de entrada, resolução da projeção, ordens recebidas/fallback carregado, composição das seções e apresentação de progresso. |
| Início | `web/inicio/bannerprincipal/{selecao,apresentacao,rotacao}.js`, `carrosseis.js` | Seleção de títulos e imagens, fatos do banner e relógios visuais de cinco segundos. |
| Minha lista | `web/minha-lista/services.js`, `orquestrador.js` | Seleção da biblioteca privada existente e apresentação por tipo. Não abre outro Auth, socket ou cache privado paralelo. |
| Filmes | `web/filmes/` | Aba, metadados/duração/prévia, biblioteca, recomendações e políticas específicas do player sobre a sessão/vídeo compartilhados. Veja a atualização de Filmes abaixo. |
| Séries | `web/serie/`, `lib/serie/` | Aba, detalhes, busca, temporadas, episódios, progresso, áudio, legendas, resolução, buffer, TanStack, Realtime e marcadores próprios sobre a sessão compartilhada. |

O início mantém seis seletores concretos, sem adicionar uma segunda fonte de catálogo:

- `lista-canais/`: projeção RPC dos quatro canais, estado, cache, prévia e apresentação.
- `ultimosfilmes/seletor.js` e `ultimasseries/seletor.js`: histórico da conta ativa.
- `lancamentosfilmes/seletor.js` e `lancamentosseries/seletor.js`: ordens de lançamentos do catálogo.
- `recomendados/seletor.js` e `recomendados/estado.js`: projeção privada, seleção já carregada quando a projeção está indisponível e estado de carregamento/erro.

`inicio/recomendados/legado.js` e `inicio/seletores-offline.js` conservam os seletores puros antigos usados por consumidores de compatibilidade e fixtures. O início ativo usa `secoes.js` e a projeção privada, não aquele recomendador legado. `login/hooks.js` é um adaptador explícito do ciclo de eventos compartilhado de `sistema/hooks.js`; não duplica essa implementação.

## Contratos preservados

Conta, geração de conexão, proteção parental e preferências delimitam os leitores. Uma resposta antiga não pode publicar dados após troca de escopo. Falha de atualização mantém o último snapshot válido da mesma conta. Um resultado privado válido e vazio continua sendo um resultado vazio, não uma falha inventada.

Auth, RLS, Realtime da biblioteca, favoritos e progresso permanecem na `CloudLibrary` e na ponte existentes. Os adaptadores dos domínios consomem essa conexão; não criam um SDK ou usuário por tela. Atualização de programação não reinicia vídeo, nem invalida Filmes/Séries.

O backend específico de TV é descrito no [mapa de TV](tv-modularization-20261016.md), no [backend/APK](tv-backend-modules-20261016.md) e no [guia global](tv-guide-global.md). As reservas `lib/filmes/` e `lib/serie/` não significam migração completa dos engines VOD. Play, stop, status, Range/proxy e sessão ainda exigem os contratos compartilhados.

## Fachadas antigas removidas

Os consumidores de produção e os imports de testes/ferramentas foram apontados diretamente às implementações canônicas. Nos testes, somente imports e caminhos esperados pelo teste do grafo estático foram atualizados. Nenhum teste foi executado nesta etapa.

| Arquivo removido | Destino dos exports |
| --- | --- |
| `web/home-cloud-model.js` | `web/inicio/tanstack-query.js` |
| `web/home-cloud-sections.js` | `web/inicio/secoes.js`, `projecao.js`, `bannerprincipal/selecao.js` |
| `web/home-sections.js` | `web/inicio/ordens.js`, `bannerprincipal/selecao.js`, `progresso.js`, `seletores-offline.js` |
| `web/home-hero.js` | `web/inicio/bannerprincipal/apresentacao.js` |
| `web/home-recommendations-state.js` | `web/inicio/recomendados/estado.js` |
| `web/home-recommendations.js` | `tests/fixtures/home-recommendations-legacy.js` |
| `web/home-bootstrap.js`, `web/entry-preparation.js` | `web/inicio/hooks.js` |
| `web/hero-rotation.js` | `web/inicio/bannerprincipal/rotacao.js` |
| `web/shelf-carousel.js` | `web/inicio/carrosseis.js` |
| `web/login-screen.js` | `web/login/tela.js` |
| `web/session-loader.js` | `web/login/preparacao.js`, `web/login/capas.js` |
| `web/settings-tools.js` | `web/sistema/configuracoes/orquestrador.js` |
| `web/settings-views.js` | `web/sistema/configuracoes/views.js` |
| `web/audio-preferences.js` | `web/sistema/configuracoes/audio.js` |
| `web/marker-sync-settings.js` | `web/sistema/configuracoes/marker-sync.js` |
| `web/series-playback-preferences-view.js` | `web/sistema/configuracoes/series.js` |
| `web/account-menu.js` | `web/sistema/conta/menu.js` |
| `web/shared-catalog-updates.js` | `web/sistema/catalogo/realtime.js` |
| `web/features/catalog-feature.js` | `web/sistema/catalogo/aba.js` |
| `web/features/live.js` | `web/tv/aba.js` |
| `web/features/movies.js` | `web/filmes/orquestrador.js` |
| `web/features/series.js` | `web/serie/orquestrador.js` |

São 23 fachadas removidas. Os nomes dos arquivos de teste e os CSS existentes permanecem: eles identificam cenários/estilos e não são implementações duplicadas. As fachadas anteriores de TV/player não fazem parte desta limpeza; a compatibilidade delas consta no mapa de TV.

## Atualização de Filmes nesta rodada

O [mapa canônico de Filmes](../web/filmes/README.md) registra a extração posterior de prévia, título/metadados, duração, recomendações, favoritos/progresso, transporte de metadados e adaptador da biblioteca. O [mapa do player](movies-player-modularization-20261016.md) descreve áudio, legendas, resolução, buffer e retomada sobre o vídeo existente. Nenhuma dessas composições cria outra sessão WPLAY/Supabase ou um segundo player.

Cinco fachadas adicionais foram removidas após migrar os imports: `web/movie-preview.js`, `movie-recommendations-model.js`, `movie-suggestions.js`, `local-movie-recommendations.js` e `related-movies.js`. O início importa a duração canônica de `filmes/duracao.js`; os testes passaram a importar as implementações correspondentes. O seletor anterior de relacionados fica apenas como fixture histórica de teste e não é importado pelo grafo servido da aplicação.

As recomendações de Filmes agora pertencem a `web/filmes/recomendacoes/`. O navegador aceita somente o DTO da RPC com ranking 2 e identidade 2, preserva sua ordem e apresenta até dez opções: cinco colunas no desktop e menos colunas em larguras menores. Não calcula afinidade nem procura candidatos no catálogo carregado. Título, franquia/universo e gênero são responsabilidades do ranking no banco; a interface apenas apresenta o vínculo retornado por candidato.

Os consumidores compartilham o modelo TanStack existente, com isolamento de conta/origem e cancelamento por destino. Uma falha da RPC conserva a última lista válida da mesma conta/origem e exibe erro; não produz um ranking alternativo. A existência dos arquivos e os bundles locais não comprovam aplicação remota da versão 2: essa confirmação pertence ao relatório da migration/RPC da etapa correspondente.

## Verificação desta etapa

Inspeção de imports, sintaxe dos módulos e bundle estático da aplicação. Sem login, consulta de mídia, testes automatizados, navegação ou reprodução. Esta reorganização não permite afirmar latência de abertura ou reprodução real.


## Correções encontradas na integração

O reset do início preserva os relógios de animação ao alterar PIN/preferências,
parando-os na troca de conta. A releitura de publicação Realtime ignora o TTL
local, compara a revisão recebida ao aviso e não confirma resposta nula/antiga.
Falhas têm até três novas tentativas (1/5/15s), canceladas por geração/reset;
a releitura usa cache=reload, sem pedir outra coleta ao provedor.

A [recuperação EPG](tv-epg-recovery-20261016.md) descreve as leituras administrativas
que confirmaram programação vigente no banco e os defeitos separados de
bootstrap/escopo/entrega. A captura WPLAY compartilhada é uma recuperação
independente da disponibilidade do Supabase; não remove banco nem dados pessoais.


## Ativação local

Servidor reiniciado após a integração e correções, emlocalhost:4173, com a
configuração da engine original preservada. Conferência da página inicial:
HTTP200, sem login ou mídia. Compilação estática final dos grafos web e servidor
passou; nenhuma experiência audiovisual foi simulada. As alterações adicionais
que chegaram à pasta durante a conferência foram preservadas e incluídas na
compilação; não foram revertidas para uma cópia anterior.
