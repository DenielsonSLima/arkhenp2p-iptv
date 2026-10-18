# Modularização de Séries — 16/10/2026

Séries foi priorizado por pedido do usuário. A implementação do domínio agora reside em `web/serie/` e `lib/serie/`, integrada ao aplicativo existente. Esta etapa reorganiza responsabilidades e preserva as interfaces externas; os defeitos operacionais anteriores ficam para correções posteriores.

## Navegador

| Responsabilidade | Arquivo canônico |
| --- | --- |
| Composição e ciclo do domínio | `web/serie/orquestrador.js` |
| Catálogo, detalhes e URL do episódio | `web/serie/services.js` |
| Busca específica de Séries | `web/serie/busca.js` |
| Capas e miniaturas | `web/serie/capa.js` |
| Título e fatos da série | `web/serie/titulo.js` |
| Prévia | `web/serie/previa.js` |
| Temporadas e episódios | `web/serie/temporadas.js`, `web/serie/episodios.js` |
| Progresso por episódio | `web/serie/progresso.js` |
| Próximo episódio | `web/serie/sequencia.js` |
| Retomada e recuperação | `web/serie/reproducao.js` |
| Áudio | `web/serie/audio.js` |
| Legendas e arquivo local | `web/serie/legenda.js` |
| Resolução e níveis disponíveis | `web/serie/resolucao.js` |
| Buffer VOD | `web/serie/buffer.js` |
| Leitores, coalescência e cancelamento | `web/serie/hooks.js` |
| Conta, geração, PIN e visibilidade | `web/serie/scope.js` |
| Cache TanStack | `web/serie/tanstack-query.js` |
| Eventos Realtime | `web/serie/realtime.js` |
| Projeção privada da biblioteca Supabase | `web/serie/supabase.js` |

São implementações consumidas pelo fluxo atual. Os antigos `series-preview.js`, `episode-progress.js` e `series-playback-sequence.js` foram removidos depois da migração de seus consumidores. Chaves e formatos de progresso permanecem compatíveis com os registros existentes.

`web/app.js` conserva a composição da aplicação: injeta dependências, coordena navegação e entrega o episódio selecionado aos módulos. `PlayerTools` encaminha áudio, legendas, resolução e buffer de Séries às políticas correspondentes. O player, o transporte, o STOP, o grafo de áudio, o seek e a biblioteca pessoal continuam com seus proprietários compartilhados. Preferências e marcadores da edição conservam seus controles já existentes, sem outra instância ou sessão.

## Servidor e RPC

`lib/serie/orquestrador.mjs` despacha exclusivamente as fatias Séries de `/api/catalog`, `/api/catalog/read-model` e `/api/details`. `catalogo.mjs` preserva paginação, geração e classificação; `metadados.mjs` retorna temporadas/episódios do provedor e a projeção limitada de arte. Não abre o primeiro episódio para atribuir duração à série.

A busca tipada reutiliza a única `RemoteSearch`, exige `type=series` e conserva ordem, contagens e paginação recebidas da RPC. Nesse tipo, o aplicativo não usa o fallback de classificação pelo snapshot local. Esta etapa não redesenha a busca global legada nem os demais modelos de navegação. Nenhuma RPC, migration, credencial ou infraestrutura remota foi modificada.

## Isolamento e invalidação

Detalhes têm leitores deduplicados, cancelamento independente e limite de64 entradas no serviço e no namespace TanStack. O QueryClient existente é emprestado; limpar/cancelar a busca afeta somente `arkhen-global-search`. Atualização manual do catálogo invalida os detalhes Séries sem interromper uma seleção autorizada em andamento ou permitir que a resposta antiga repovoe o cache.

Conta, geração, PIN e visibilidade de Séries protegem os leitores. A conclusão tardia do bootstrap cloud da mesma conta não cancela a prévia. Realtime consome os eventos da conexão existente e invalida somente a projeção afetada; progresso não recarrega catálogo nem vídeo. Progresso permanece por conta e episódio, com veto para conteúdo adulto. Retomada/recuperação conserva a pausa por429 e rejeita callbacks de uma seleção encerrada.

## Verificação e limites

166 testes sintéticos passaram, cobrindo apresentação, miniaturas, progresso, sequência, marcadores, busca, cache, cancelamento, Realtime, políticas do player e rotas reais do `createApp` com provedor simulado. As rotas conservam PIN por sessão, métodos/IDs válidos e logout isolado; Filmes mantém sua política de duração e TV mantém catálogo/fontes. O teste de integração falha se tentar solicitar mídia.

O bundle da aplicação foi conferido em memória, com as rotas virtuais `/assets/*` mantidas como recursos do servidor. Sintaxe e whitespace foram conferidos. Após reiniciar o servidor local,23 recursos da página/módulos responderam HTTP200 e o catálogo Séries sem sessão manteve HTTP401. Não houve navegador, reprodução, teste visual, acesso ao banco ou deploy nesta etapa. O teste visual permanece com o usuário; reiniciar o servidor pode exigir novo login por conta da sessão em memória.

A regressão ampliada encontrou quatro expectativas antigas em `tests/cloud-library.test.mjs` e duas fixtures TV sem `sources` em `tests/player-quality.test.mjs`. Os agentes reproduziram as falhas contra as implementações de HEAD anteriores à extração; não foram tratadas como falhas novas nem corrigidas nesta etapa.

## Próximas etapas registradas

1. Recuperar a biblioteca/Supabase e diagnosticar o timeout de identidade com evidência atual, separando-o da reprodução do provedor.
2. Corrigir e conferir capas dos filmes favoritos e a faixa inicial de quatro canais: mais assistido e três recentes, seleção por RPC e prévia muda.
3. Retomar os casos de reprodução de TV/Filmes/Séries e as sugestões intermitentes, por fluxo e título, após o teste do usuário.
4. Validar a versão a publicar na Vercel. Esta modularização ainda não certifica produção.

Fontes: [módulos do navegador](../web/serie/README.md), [backend](../lib/serie/README.md), [mapa do player](player-modules.md), [incidente Supabase](supabase-incident-20261016.md) e [WPLAY](wplay/README.md).
