# Séries: marcações externas por episódio em reprodução

Data: 17/10/2026. Estado: implementação local ativada; validação sintética e consulta pública reais. Reprodução audiovisual no Safari ainda não conferida.

## Pedido e etapas

1. Consultar apenas o episódio que entrou em reprodução, sem varrer temporadas, catálogo ou detalhes em prévia.
2. Aceitar os horários comunitários para teste do usuário. No pedido posterior de 17/10, o usuário corrigiu a interação: o padrão deve exibir contagem de 5 segundos e saltar automaticamente a introdução e os créditos, com cancelamento e ação imediata. Isso substitui a política inicial de clique obrigatório, sem transformar referência comunitária em prova da edição.
3. Reutilizar resultados e cancelar o consumidor quando mudar episódio, fonte, conta ou sair do player.
4. Por decisão posterior do usuário, tolerar diferenças entre fontes de até **5 segundos, inclusive**. Acima disso, sinalizar divergência nos ajustes, mantendo o intervalo integral da fonte principal. Não calcular média nem acrescentar consultas só para comparação.

## Implementação

- `web/player/orquestrador.js` exige o evento `playing` antes da consulta. `EpisodeSkipController` conserva referências separadas das marcações manuais/verificadas, mas ambas participam da contagem cancelável de 5 segundos conforme as preferências de reprodução, habilitadas por padrão.
- `web/serie/marcadores/sob-demanda.js` resolve a identidade IMDb existente, S/E e ID nativo do episódio. Identidades conflitantes não são substituídas por busca aproximada. Se necessário, lê somente a identidade já resolvida da série na CloudLibrary autorizada, com prazo de 1s.
- `GET /api/series/episode-markers` exige sessão, reprodução ativa do ID solicitado e autorização parental. Respostas respeitam a geração de reprodução/conta e cancelamento do HTTP/stream.
- `lib/serie/marcadores/sob-demanda.mjs` consulta SkipDB com IMDb/S/E/duração em segundos e `adjust=none`. IntroDB é fallback somente quando faltar intro ou outro. Intervalos nunca são combinados pela média/interseção. Ausência confirmada `0/0` no SkipDB impede substituição daquele tipo pelo fallback.
- Respostas públicas são limitadas a 64KiB e 3s por fonte; pedidos iguais compartilham uma chamada. Há espaçamento por fonte, cooldown de 429/503 e no máximo duas consultas por falta no cache. Falha deixa a reprodução seguir.
- Cache em memória do servidor: até 512 chaves IMDb/S/E/duração. Cache do dispositivo: até 120 entradas, chave opaca por conta, série, episódio, fonte lógica e duração; nenhuma URL/credencial de mídia é salva. Referências duram 24h; ausência, 1h; indisponibilidade, 60s. Não há consulta antecipada do episódio seguinte. Cache de servidor e limites são por instância, não um cache distribuído entre réplicas.
- O final de `outro` é preservado. Se terminar antes do vídeo ou houver cena pós-créditos/prévia posterior, a contagem termina em um seek até esse conteúdo; um final indicado até o término do arquivo avança ao próximo episódio, quando existir, ou ao fim do último episódio. Sem marcação, o padrão aguarda o `ended` real. A preferência explícita “Quando terminar” também aguarda `ended`.
- A contagem pausa em pause/waiting/stalled/seeking e só retoma após `playing`. Cancelamento permanece no episódio; troca de conta/episódio/fonte/duração revoga o trabalho antigo. Uma marcação que chega durante a reprodução recebe 5 segundos completos; introdução com menos de 5 segundos restantes mantém apenas ação manual. Sair da janela de créditos cancela o salto para não atravessar uma cena posterior. O mesmo seek pendente não é enviado novamente.

## Supabase

Projeto autorizado: `wnicimkmzswksaqdtgdv`. Inspeção limitada de `cron.job`, sem logs, encontrou `arkhen-series-markers-sync` ativo a cada dois minutos e `arkhen-marker-sync-metrics` já inativo. A operação idempotente [SQL](../supabase/operations/20261017_series_markers_on_demand.sql) desativou o primeiro e conservou o segundo inativo; leitura após commit confirmou ambos `active=false`.

Nenhuma tabela, identidade ou marcação foi apagada; nenhuma Edge foi publicada. A operação desativa novos disparos agendados, não certifica encerramento de uma execução que já estivesse em andamento. Ferramentas administrativas de coleta continuam disponíveis para execução explícita. Para reverter a política, reativar somente o job de coleta por nome após decisão de produto; métricas já estavam desativadas antes desta alteração.

## Evidências e limites

- Alteração posterior da contagem: 82 testes automatizados aprovados (controlador, referências sob demanda, preferências, player de Séries e sequência), incluindo API assíncrona, relógio 5/4/3/2/1, pausas, cancelamento, ação imediata, pós-créditos, último episódio, geração/conta/duração e seek pendente. Bundle do aplicativo e diff validados. Três módulos atualizados conferidos por HTTP200 no localhost, iguais aos arquivos em disco; nenhuma reinicialização do servidor nem alteração de banco foi necessária. Sem novo teste audiovisual no Safari nesta etapa.
- 101 testes aprovados: 98 de controladores/caches/contratos e 3 de integração HTTP. Cobrem limite 5/5,001s, cancelamento, cache por conta/episódio/fonte/duração, troca de duração enquanto pausado, ausência, 429, limites de payload, identidade conflitante, sessão e parental. Os testes HTTP usaram provedor simulado e loopback descartável.
- Bundle `web/app.js` válido com `/assets/*` externo, como carregado em runtime pelo site; verificação de sintaxe e diff sem erros nos arquivos envolvidos.
- Consulta pública real de `tt0903747`, S1E1, duração informada 3500s: SkipDB respondeu intro 229,5–246,5s e outro 3434–3500s; IntroDB respondeu outro 3431–3500s. Diferença de 3s é tolerada. Isso verifica o contrato HTTP e não a sincronização com uma edição WPLAY.
- O próprio novo serviço retornou referência normalizada e reutilizou o cache na segunda leitura.
- Servidor local reiniciado para carregar a rota. Reinício encerra sessões em RAM. Home e quatro módulos JS retornaram HTTP200; nova rota sem sessão retornou HTTP401. Nenhum deploy de produção.
- Controle remoto Safari falhou com `Sky Computer Use native pipe startup failed`. Não declarar validação visual, cobertura total nem precisão audiovisual no catálogo.

## Opções de fornecedores

Recomendação inicial: SkipDB principal, IntroDB complementar, pela consulta leve por episódio e pelo parâmetro de duração do SkipDB. Nenhuma das duas é certificação da edição.

| Serviço | Oferta e adequação |
| --- | --- |
| [SkipDB](https://skipdb.tv/docs) | Leitura pública; intro/recap/outro/preview, IMDb/S/E/duração. Dados ODbL + reciprocidade; avisos e licença existentes preservados em `web/series-markers/open-data/`. |
| [IntroDB](https://introdb.app/docs/api) | API gratuita; consultas por episódio e documentação de créditos/pós-créditos. |
| [TheIntroDB](https://github.com/sponsors/TheIntroDB) | Outra base comunitária gratuita, distinta do IntroDB. Alternativa a avaliar, não integrada nesta etapa. |
| [AniSkip](https://api.aniskip.com/api-docs) | Aberturas/encerramentos de anime; exige identidade e numeração próprias. Não integrado nesta etapa. |
| [Amazon Rekognition](https://docs.aws.amazon.com/rekognition/latest/dg/segments.html) | Análise paga de vídeo armazenado no S3. Gera limites do conteúdo fornecido, com processamento prévio; não substitui uma busca imediata por IMDb. [Preços](https://aws.amazon.com/rekognition/pricing/). |
| [Media Distillery](https://mediadistillery.com/solutions/time-marker-suite) | Solução empresarial de análise e geração de marcadores, comercialização por contato/demo. Não foi solicitada cotação nem contratada. |

Fontes consultadas em 17/10/2026. Nenhuma compra ou serviço pago foi ativado.
