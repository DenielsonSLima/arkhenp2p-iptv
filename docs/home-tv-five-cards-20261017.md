# Home TV: destaque, quatro recentes e programação

Data: 16/10/2026 local, 17/10 UTC. Pedido posterior às capturas das 23h02: reduzir a altura dos cards, mostrar um destaque à esquerda e quatro recentes à direita, usar TV Globo na ausência de destaque medido, apresentar programação e reproduzir uma prévia com abertura em tela cheia. Três agentes revisaram UI, RPC e reprodução; a integração EPG ficou com o principal. Testes internos foram autorizados; navegador e mídia real não foram usados.

## Diagnóstico e implementação

Os cards já pertenciam a `web/inicio/lista-canais/`. A prévia existente só recebia alvo com `mostWatchedId`; uma lista composta apenas de recentes não iniciava vídeo. O CSS usava proporção 16:9 crescente com a largura. A programação compartilhada de TV ainda não tinha um consumidor nessa faixa.

- A RPC mantém o campeão da janela exata de 168 horas. Sem campeão elegível, escolhe Globo genérica ou a primeira Globo elegível na ordem nativa do catálogo, preservando o nome regional. A leitura de nomes globais confirmou afiliadas como Globo SP; não se infere a região da conta. GloboNews/Globo News/Globoplay, adulto, oculto e indisponível não são padrões elegíveis.
- `featuredId` identifica a prévia. `mostWatchedId` continua nulo para `default-globo`, que possui zero segundos e `lastWatchedAt:null`. O padrão não escreve histórico. Até quatro recentes reais seguem o destaque; versões técnicas repetidas não ocupam dois lugares, preservando regiões e números. Não se inventam quatro recentes quando faltam dados.
- Candidatos com histórico ou nomes Globo são materializados antes dos classificadores e processamento de metadados. Buckets, batimentos, retenção e coletores não mudam.
- A grade tem cinco colunas no desktop, três no tablet e duas no celular; o quadro tem altura limitada a 124px. O vídeo preserva o enquadramento inteiro. A apresentação mostra Agora/A seguir, horários e progresso recebidos do servidor.
- `HomeChannelPrograms`, em `programacao.js`, assina a grade `tvGuide` existente com até cinco IDs. Não cria SDK, request por card ou relógio. Saída da Home cancela a assinatura; troca de conta invalida callbacks. `updatePrograms()` altera apenas o texto/progresso, sem mover ou reiniciar o vídeo.
- Dois defeitos foram reproduzidos internamente antes da correção: fullscreen solicitado após uma importação assíncrona perdia a ativação do clique; STOP remoto podia terminar antes da liberação assíncrona do decoder. A abertura Home agora solicita fullscreen após autorização/PIN e antes da espera pela engine. A prévia aguarda encerramento local e remoto antes da próxima fonte. Troca de conta não envia STOP antigo à nova sessão. Prévia permanece silenciosa, sem histórico ou batimentos.

## Validação e ativação

44 testes Node focados passaram em conjunto: DTO, backend, grade, EPG, prévia, fullscreen, conta e recuperação. O harness PostgreSQL em memória passou 113 asserções, incluindo 24 novas de Home TV; isso não mede latência remota. Bundle ESM, sintaxe e `git diff --check` passaram. Dois agentes revisaram independentemente o contrato SQL/ACL.

Arquivo local: `supabase/migrations/20261017020723_arkhen_home_tv_featured_and_four_recent.sql`. Aplicado somente ao projeto autorizado `wnicimkmzswksaqdtgdv`. A Management API registrou o nome `arkhen_home_tv_featured_and_four_recent` com versão remota `20261017021613`; o timestamp remoto difere do arquivo, sem reaplicação. Readback às 02:16:48 UTC confirmou `arkhen_home_tv.prosrc` MD5 `ee5dac8cef4d0c15fb95a753a05002d5`, definer, search_path vazio, statement3s, jit off, EXECUTE autenticado e sem EXECUTE anônimo. Nenhum perfil real foi selecionado para simular claims ou executar a RPC privada.

O servidor local foi reiniciado uma vez; página e três assets da faixa responderam HTTP200. O cliente novo aceita o DTO anterior; a página antiga precisa recarregar para aceitar cinco cards e o motivo de padrão. O reinício pode exigir nova entrada. Não houve publicação do site, execução de coletores ou alteração de infraestrutura nesta etapa. Autoplay, fullscreen nativo, programação disponível e aparência em dispositivos ainda dependem de validação real pelo usuário.

Fontes: `web/inicio/lista-canais/README.md`, `docs/tv-home-backend-20261016.md`, migration citada, `tests/home-channel-*.test.mjs`, `tests/home-tv-*.test.mjs` e `tools/test-home-library.mjs`.
