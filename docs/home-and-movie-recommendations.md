# Entrada e recomendações — 15/10/2026

Três frentes dividiram a solicitação: `catalog_completion` cuidou da entrada animada, `sync_registry_backend` da RPC e API privada, e `sync_registry_ui` das sugestões de prévia e fim de filme. A integração principal cuida da seção da home, do cache e da verificação conjunta.

## Comportamento

- Login e preparação da sessão usam a mesma linguagem visual do carregamento de vídeo. Animações não criam progresso nem retardam a entrada. Movimento reduzido é respeitado. [Detalhes](entry-preparation-motion.md).
- A home conserva “Recomendados para você” abaixo dos lançamentos de séries. Os itens e sua ordem vêm de `arkhen_home_library`, que já usa o histórico privado e gêneros. Sem sinal pessoal, o subtítulo informa “Filmes e séries bem avaliados”. Falha ou ausência da nuvem exibe estado explícito e botão de tentar novamente; não remove a seção nem gera recomendações locais.
- A prévia recebe sugestões por RPC tanto em “Assistir agora” quanto em “Continuar assistindo”. Atualizar metadados/duração preserva a seção e seus controles.
- O evento real `ended` de um filme abre uma tela com até três sugestões. Apenas atingir numericamente a duração não basta. Há Assistir, Detalhes, Rever do zero e Voltar ao catálogo; nenhuma sugestão inicia automaticamente. Filmes adultos, TV e episódios de série não abrem essa tela. [Experiência e testes](movie-suggestions-experience.md).

## Cálculo e cache

O banco prioriza os gêneros reais da origem, categorias específicas, afinidade com histórico privado e nota. Origem, variantes, filmes assistidos, ocultos e adultos são excluídos. Quando faltam gêneros/categorias úteis, o retorno identifica o fallback por nota e a interface usa rótulo compatível. A disponibilidade da informação é preservada; não inferimos gênero somente pelo nome do título. [Contrato e publicação da RPC](movie-recommendations-rpc.md).

`MovieRecommendationsModel` compartilha uma consulta de até 12 resultados entre prévia e tela final e apresenta o limite pedido, sem ordenar nem pontuar candidatos no cliente. TanStack Query usa chave com conta, projeto, provedor, partição, origem, revisões e filtros; frescor de 60 segundos e retenção limitada aos resultados recentes. O cache pertence à conta e é limpo no encerramento/troca de conexão.

Cada destino possui seu sinal de cancelamento. Fechar a prévia não cancela outra consulta ainda usada pela tela final. Quando não resta consumidor, a chamada HTTP é interrompida. Mudança de conta, filtros e respostas tardias são conferidas antes da entrega. A RPC não é solicitada a cada quadro ou atualização de progresso.

## Verificação integrada e disponibilidade

`node --test tests/*.test.mjs`: 1.070 testes, 1.069 aprovados, nenhuma falha e um skip de symlink no Windows. O grafo da interface compilou 82 módulos sem avisos. O fixture PostgreSQL/RLS passou em 89 asserções e os nove testes de API incluíram o transporte autenticado das recomendações.

Chromium isolado conferiu entrada em cinco tamanhos, progresso real e movimento reduzido. Outra fixture usou a aplicação real com provedor, mídia e recomendações simulados para verificar prévia em andamento, três sugestões ao terminar, histórico concluído, ausência de autoplay, teclado/foco, rever do zero, assistir/detalhes e recuperação da home após falha. Zero exceções JavaScript. Evidências privadas em `.local/entry-motion-*`, `.local/movie-suggestions-*` e `.local/recommendations-suite-final.log`; processos temporários encerrados.

**A publicação remota da migração `20261015192346` não foi confirmada.** O projeto Supabase respondeu de forma intermitente e o health check das 16:32 de 15/10/2026 informou todos os serviços `UNHEALTHY`. A última leitura limitada não respondeu. O código e os testes locais não comprovam que a RPC está disponível no projeto remoto; essa confirmação e a medição com JWT permanecem pendentes. O [relatório sanitizado](../reports/movie-recommendations-validation-2026-10-15.json) conserva essa distinção. Nenhum lote audiovisual antigo foi apresentado como confirmado por esta etapa.
