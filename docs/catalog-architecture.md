# Catálogos e biblioteca por domínio

## Dados e responsabilidades

| Domínio | Cliente | Supabase | Reprodução |
| --- | --- | --- | --- |
| Filmes | `web/features/movies.js` | `media_type=movies`; tarefa própria, cursor, lease e revisão | HTTP do provedor; sem iniciar transporte OTT de TV |
| Séries | `web/features/series.js` | `media_type=series`; tarefa própria, cursor, lease e revisão; marcadores por episódio | Temporadas/episódios e HTTP do provedor |
| TV | `web/features/live.js` | `media_type=live`; tarefa própria; EPG e agenda em tarefas separadas | HTTP nativo ou transporte privado do player web WPLAY |
| Biblioteca pessoal | `web/library-selectors.js`, `web/cloud-app-bridge.js` | Favoritos, progresso, coleções e preferências por usuário, com RLS | Identificadores nativos preservados |

O código comum de transporte e armazenamento é compartilhado. Cada domínio possui estado independente; trocar a categoria em Séries não altera a categoria de Filmes. As tabelas globais usam provedor, escopo e tipo para evitar duplicação de metadados sem misturar tarefas ou bibliotecas pessoais.

## Ciclo de carregamento

1. `CatalogRepository` separa chaves por projeto, provedor, escopo, tipo e desbloqueio adulto. A geração da conta e a geração da requisição impedem commits atrasados.
2. IndexedDB fornece o último catálogo completo. Dentro de 24 horas, a reabertura não faz nova consulta de catálogo. Após o prazo, o catálogo anterior permanece disponível enquanto ocorre a atualização.
3. TanStack Query Core deduplica leituras. Prévias permanecem vencidas e podem ser enriquecidas quando a publicação ficar disponível. Catálogo completo e prévia têm slots distintos.
4. Resposta parcial, vazia, de outro tipo, com revisão anterior ou sem versão sobre um snapshot versionado não derruba o último completo. Erro de atualização mantém seu conteúdo e sua idade.
5. Somente uma resposta completa aceita pode renovar a persistência. Uma resposta rejeitada não transforma dados antigos em dados recém-atualizados.

O formato persistido é versão 2. Registros antigos são tratados como ausentes até a primeira resposta completa aceita, que os substitui atomicamente; biblioteca pessoal e alterações pendentes não são removidas. O envelope completo da API preserva snapshot, revisão e expiração do header publicado.

O aplicativo carrega todos os metadados do snapshot para navegação e cache. A busca global consulta a geração publicada por RPC, independentemente dos cards montados. A montagem incremental de cards e o carregamento de imagens reduzem memória e trabalho visual; não limitam a busca aos cards visíveis.

## Cálculos e consultas

`arkhen_global_search` filtra, classifica e conta resultados no Supabase. O cliente exige três caracteres normalizados, aguarda 300 ms e cancela a consulta substituída. Conta, partição, bloqueio adulto e filtros privados compõem o escopo; respostas atrasadas não substituem o estado atual.

`arkhen_catalog_read_model` entrega ordens por nome/data/nota, lançamentos, destaques e associações de categorias/gêneros preparados por geração. Esses índices são persistidos junto ao catálogo completo. Um cache diário válido sem modelo recebe somente o modelo, sem baixar todo o catálogo novamente e sem renovar sua idade. Falha de preparação preserva os dados válidos. Um índice local por snapshot conserva a navegação quando o modelo remoto ainda não está disponível.

`arkhen_home_library` calcula histórico, contagens de favoritos e recomendações para `auth.uid()`. A resposta privada é limitada e usa cache separado do catálogo global; favoritos e progresso ainda não confirmados mantêm a resposta imediata no dispositivo. Controles visuais, seek, progresso do player e seleção da janela de abertura continuam locais.

Contratos, limites e medições: [busca e modelos de catálogo](catalog-query-models.md), [home privada](home-library-rpc.md) e [registro de sincronização](marker-sync-registry.md).

## Favoritos e Realtime

Favoritos começam nos registros privados da conta, com enriquecimento pelo catálogo quando disponível. A ausência de um favorito na prévia não o remove de Minha lista nem do filtro Favoritos de seu domínio. Dados de outra conta são rejeitados.

Realtime pessoal atualiza a projeção afetada. Progresso não recarrega os catálogos de Filmes/Séries/TV. Preferências de catálogo e favoritos podem alterar a navegação; preferências de áudio não reconstruem os cards. Eventos de catálogo carregam tipo e revisão, respeitando o cache diário; eventos sem tipo não limpam todos os domínios.

## Publicação no Supabase

O coletor recebe páginas autorizadas do provedor e preserva seu progresso em tabelas privadas. Normalização, preparação e publicação têm checkpoints e diagnóstico por fase. Nenhum item de staging é apresentado como importação completa.

Jobs ativos incluem o tipo na identidade, além de provedor, escopo e operação. Um job de Filmes pode falhar ou adiar sua publicação sem bloquear o job de Séries. A migração de separação preserva o ID e o staging do job legado de Filmes.

A publicação usa índices por geração. Cada execução copia até 256 títulos e suas referências de arte; a geração candidata permanece invisível pelas políticas RLS. Depois da conferência das contagens, uma transação troca o header completo e o ponteiro `catalog_visible_generations`. Os leitores continuam usando a geração anterior até esse commit. Limpeza limitada preserva a geração ativa e preparações em andamento.

O Realtime assina `catalog_visible_generations`, um registro pequeno por domínio, em vez de transmitir o JSON completo ou alterações individuais de milhares de títulos. A biblioteca pessoal não participa dessa substituição. Credenciais, cookies e URLs de vídeo assinadas não entram no cache global de catálogo nem no IndexedDB de metadados.

## Navegação e conteúdo restrito

As categorias do provedor são ordenadas por colação pt-BR. Favoritos, Todos e Jogos de hoje são categorias utilitárias; Jogos de hoje só aparece dentro de TV ao vivo. A home não consulta nem monta a agenda.

Conteúdo adulto fica bloqueado por padrão, com PIN inicial `0000`. O desbloqueio faz parte do escopo do cache. Ao bloquear novamente, respostas adultas em andamento perdem validade e o cache correspondente é removido.

## Verificação

Os testes `catalog-domains`, `catalog-cache`, `cloud-app-bridge`, `shared-catalog-updates` e `cloud-library` cobrem geração, revisões, biblioteca privada e atualizações. Testes de transporte cobrem associação de canais, cancelamento e isolamento de autenticação.

Em Chromium isolado, com API explicitamente sintética, foram verificados os casos de 4 filmes/17 séries de prévia e 37 favoritos; catálogo completo seguido de prévia ou HTTP 503; ausência de transição vazia no DOM; cache diário em IndexedDB; troca de conta/escopo; agenda somente na categoria selecionada. Isso verifica a aplicação, sem comprovar a disponibilidade real do provedor ou a publicação remota de todos os títulos.

O estado real da importação, as versões aplicadas e os limites de validação ficam no [plano de estabilização](engineering-recovery.md). A validação final da experiência pertence ao usuário.

Em 15/10/2026, a leitura autenticada real confirmou os três snapshots: 18.612 filmes, 8.124 séries e 760 canais; com bloqueio adulto, 18.211, 8.118 e 659, respectivamente. Contagens completas, filtro e isolamento foram comparados à API. Isso comprova os metadados publicados, sem afirmar que toda mídia do provedor foi reproduzida.
