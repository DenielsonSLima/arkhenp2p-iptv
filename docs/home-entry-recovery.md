# Recuperação de entrada e Início — 15/10/2026

A entrada preserva a validação parental e ativa a biblioteca da conta antes de mostrar conteúdo. Depois disso, a cobertura de preparação termina no primeiro catálogo visível da tela escolhida ou após 1,5 segundo. No Início, TV, filmes ou séries podem liberar a interface. Um snapshot diário já aceito também conta, mesmo enquanto sua atualização de rede continua.

`web/entry-preparation.js` coordena somente essa espera. Encerrar o splash não cancela downloads, preparação da home nem decodificação de imagens. Essas tarefas usam um controlador próprio da entrada, conferem geração/conta e são interrompidas na troca de conexão ou alteração local de filtros/proteção parental. Os três domínios concluem de forma independente; as promessas de trabalho em segundo plano têm tratamento de falha. As capas não bloqueiam a navegação.

A projeção privada do Início começa com a sessão/nuvem disponível e é atualizada por revisões de catálogo, biblioteca e filtros, com o agrupamento de consultas do `HomeCloudModel`. Trocar de aba, abrir uma prévia ou Configurações não cancela a consulta da conta. Reset de conexão, filtros ou proteção continua descartando o escopo anterior. Falhas transitórias possuem três novas tentativas em 15, 30 e 60 segundos; a ação manual vence a espera programada e uma falha não altera a data do último sucesso.

Quando a projeção privada está ausente, a prateleira usa somente as ordens `featured` já carregadas, intercalando filmes/séries com os mesmos filtros e limite de 30 itens. O subtítulo é “Seleção do catálogo carregado”. Nenhum sinal privado ou pontuação é inferido. Uma resposta privada válida vazia permanece autoritativa.

Na integração de TV, cada abertura recebe um `attempt` novo, conservado nos pedidos de manifesto daquela abertura. O parâmetro só acompanha a URL ao vivo. A seleção de HLS nativo usa `supportsNativeHLS`, evitando interpretar a declaração opcional do Chromium como o pipeline do Safari. URLs de filmes e episódios permanecem com o contrato anterior.

Nesta alteração foram feitas revisão estática e conferência de sintaxe com `node --check`. Por solicitação do usuário, não foram executados testes, navegador ou reprodução. Após a integração, o servidor local foi reiniciado preservando o modo P2P existente. O comportamento implementado ainda depende da validação do usuário; nenhuma estabilidade remota ou reprodução real é declarada comprovada.
