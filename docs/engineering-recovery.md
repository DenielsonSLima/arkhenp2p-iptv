# Plano de estabilização ARKHEN

Atualizado em 15/10/2026. Responsável pela integração: agente principal. A validação final da experiência pertence ao usuário; a equipe executa as verificações internas e registra evidências antes da entrega.

## Decisões do produto

- WPLAY continua fornecendo autenticação, catálogo e mídia. O player web confirmado é https://player.wplayott.com/auth. O aplicativo ARKHEN preserva sua interface imersiva.
- Supabase mantém biblioteca individual, progresso, preferências, cache global de metadados e marcadores. Vídeo não será hospedado no Supabase.
- A reprodução padrão deve funcionar pela web em Windows/macOS/Linux. O experimento Android foi interrompido; nenhum AVD foi iniciado. SDK/Python/arquivos privados foram preparados e WHPX foi habilitado, sem reiniciar o computador.
- Preservar os identificadores e a propriedade dos favoritos do usuário. Os 37 confirmados inicialmente são uma referência histórica, não um limite; novas inclusões são preservadas. Nenhuma migração de identidade ou troca de conta implícita.
- Filmes, séries e TV devem ter estados, tarefas, erros, cache e atualizações independentes. Código comum serve a transporte, segurança e contratos; a falha de um catálogo não bloqueia outro.

## Solicitações consolidadas

| Solicitação | Critério de conclusão |
| --- | --- |
| Minha lista em qualquer navegador/TV | Mesma conta recupera favoritos, coleções e preferências; outra conta não recebe esses dados. |
| Continuar assistindo | Progresso por filme/episódio no Supabase, retomada e próxima reprodução corretas após nova sessão. |
| Catálogos completos | Filmes/séries/TV carregam conteúdo do provedor, categorias e gêneros; favoritos não representam o catálogo inteiro. |
| Estabilidade visual | Refetch, progresso, Realtime, erro ou prévia atrasada não apagam conteúdo válido nem fazem cards sumirem/reaparecerem. |
| Cache diário na TV/Chrome | Snapshot completo por tipo em IndexedDB por 24 horas; atualização em segundo plano preserva o último conteúdo válido. Busca por RPC considera toda a geração publicada. Cards/imagens podem ser montados conforme a navegação. |
| Compartilhamento global | Metadados reaproveitados por provedor/escopo/tipo. Favoritos, listas e progresso continuam privados com RLS. |
| Reprodução ao vivo | Obter fonte HTTP autorizada da WPLAY; quando necessário consultar o transporte do player web com a mesma conta. Não converter sintaticamente TVBus em HTTP nem escolher canal ambíguo. |
| Experiência de séries | Temporadas/episódios, próxima reprodução, abertura/recapitulação/créditos, respeitando a edição e a duração do episódio. |
| SkipDB e IntroDB | SkipDB primeiro, IntroDB.APP como alternativa; cache global antecipado. Revisar 50 séries sem inventar correspondências ou intervalos. |
| Registro global de sincronização | Novo módulo em Configurações mostra estado, fontes, última atualização, cobertura e histórico de SkipDB/IntroDB. Distingue referências globais de séries identificadas no catálogo; consulta somente ao abrir ou atualizar o registro. |
| Cálculos no Supabase e busca global | Busca, ranking e contagens por RPC autenticada; mínimo de três caracteres normalizados, debounce de 300 ms e cancelamento. Ordenações e índices de categorias/gêneros são preparados globalmente por geração para reutilização no cache diário. Interações visuais e alterações pessoais ainda pendentes de sincronização mantêm resposta local. |
| Categorias | Ordem alfabética pt-BR em Filmes/Séries/TV; utilitários e grupos pessoais têm identificação explícita. |
| Conteúdo adulto | Bloqueado por padrão, PIN inicial 0000; backend e cache respeitam o bloqueio. |
| Jogos | “Jogos de hoje” somente como categoria dentro de Ao vivo; sem agenda no topo ou na home. |
| Modularização e documentação | Módulos de Filmes/Séries/TV com contratos próprios, jobs independentes no Supabase, skills técnicas e registro das alterações. |

## Reunião técnica e evidências de partida

Os três agentes revisaram o estado antes de retomar alterações. As nove imagens mostram Filmes alternando entre quatro favoritos e vazio, Séries sem títulos ou com prévia de 17, contagens conflitantes e agenda fora do local solicitado.

Falhas confirmadas no código: o filtro Favoritos dentro dos catálogos faz interseção apenas com os itens já carregados; o fallback de registros privados funciona apenas em Minha lista. A contagem de prévias não considera adequadamente `preparing/catalogComplete`. Existe caminho de atualização que aceita uma resposta parcial sobre dados anteriores e eventos de biblioteca/catálogo provocam renderizações e invalidações amplas.

Estado remoto confirmado às 14:56 UTC: apenas TV tem snapshot completo com 760 itens. Filmes tem 897 páginas preservadas, 18.612 IDs normalizados, 37 categorias e 37.167 referências de arte privadas, ainda sem publicação completa. Séries tem prévia de 17; o job compartilhado deixa sua coleta atrás da publicação de Filmes. Última falha tipada: `COLLECTOR_PUBLICATION_SNAPSHOT_57014`, aos 57.172 ms. Isso identifica a operação interrompida; não mede isoladamente o custo do snapshot, pois o tempo inclui operações anteriores.

Não declarar importação completa a partir de staging, normalização, teste sintético ou contagem de favoritos.

## Etapas e responsáveis

| Etapa | Responsável | Entrega e verificação interna |
| --- | --- | --- |
| 0. Congelar e registrar | Principal + três agentes | Checkpoints recebidos; arquivos e jobs preservados; sem novos patches paralelos antes deste plano. |
| 1. Separar dados no cliente | sync_cliente | Repositório por projeto/provedor/escopo/tipo/adulto, módulos de Filmes/Séries/TV, seletores de favoritos privados e commit que rejeita respostas atrasadas/inferiores. Reproduzir os estados 0/4/17 das imagens em teste. |
| 2. Separar tarefas no Supabase | sync_backend | Jobs independentes `live/movies/series`, leases/cursor/backoff/revisões próprios e leitura restrita ao tipo. Cutover preserva o job e o staging de Filmes. Medir fases da publicação e corrigir o gargalo demonstrado. |
| 3. Reprodução web WPLAY | player | Transporte OTT privado e lazy para TV, separado de VOD; associação exata e única, headers corretos, cancelamento/stop por sessão. Owner e IDs nativos permanecem estáveis. |
| 4. Biblioteca e experiência | Principal coordena, agentes revisam | Integrar Realtime pessoal, cache diário, categorias/gêneros, adulto, jogos e continuação. Marcadores por episódio sem interferir em filmes/TV. |
| 5. Verificação integrada | Principal + revisão independente | Navegação, refresh, API lenta/erro/offline, duas contas, Realtime/progresso, cache 24h, retomada, catálogo integral e reprodução. Usar sessão de teste própria; não apagar dados do usuário. |
| 6. Entrega | Principal → usuário | Registro do que mudou, evidências, limitações reais e aplicativo pronto para a validação final do usuário. Não solicitar testes intermediários repetidos. |

## Contratos de isolamento

Cliente: cada tipo mantém snapshot completo, prévia, revisão, carregamento e erro próprios. Favoritos consultam a biblioteca da conta mesmo que o item não esteja na prévia. Trocar de aba não troca os dados de outro tipo. Erro/refresh preservam o snapshot válido.

Supabase: a chave global contém `provider_key`, `scope_hash` e `media_type`; a fila deve conter o tipo também na identidade da tarefa. Tarefas de TV, Filmes e Séries não compartilham cursor ou estado terminal. Biblioteca pessoal é vinculada ao usuário com RLS. O publisher só expõe um snapshot completo após commit; dados privados de preparação não são tratados como catálogo público.

Realtime: favorito/progresso/preferência atualiza apenas sua projeção pessoal. Mudança global identifica o tipo/revisão, sem limpar todos os catálogos. O TTL diário do catálogo não se aplica à sincronização da biblioteca individual.

Reprodução: filmes e episódios HTTP não inicializam transporte OTT de TV. O transporte web não muda IDs/catalogação nem publica cookies, URLs assinadas ou credenciais em caches globais.

## Política de execução e registro

- Um responsável por conjunto de arquivos. Mudanças em arquivos compartilhados são combinadas antes da edição.
- Antes de novo deploy, revisar o diff, executar testes do contrato afetado e registrar versão/resultado. Diagnósticos contêm códigos, fases e números; nunca credenciais.
- Não repetir alterações por hipótese enquanto a evidência não localiza a falha. Preservar os checkpoints e o último snapshot válido.
- Registrar resultados abaixo, distinguindo implementação, teste isolado e confirmação remota real.

## Registro após a reunião

| Data | Alteração | Evidência | Estado |
| --- | --- | --- | --- |
| 15/10/2026 | Congelamento, reunião dos três agentes e consolidação das solicitações | Checkpoints e leitura do código/imagens | Concluído |
| 15/10/2026 | Skills de otimização, IPTV, P2P, TanStack Query, Realtime, Supabase e APK | Sete diretórios em `skills/`; validador oficial executado nas fontes e nas cópias instaladas em `~/.codex/skills/arkhen-*`. Seguidas manualmente nesta execução; descoberta automática a partir do próximo turno. | Concluído |
| 15/10/2026 | Isolamento cliente/Supabase e transporte web | Etapas 1–3 descritas nas linhas abaixo e em [arquitetura dos catálogos](catalog-architecture.md). | Implementação integrada; publicação remota em verificação |
| 15/10/2026 | Cliente dividido em repositório e features Filmes/Séries/TV; seletores da biblioteca separados do catálogo | Chromium real, API sintética: 37 favoritos com prévias 4/17; 60 títulos completos por VOD preservados após prévia/503; MutationObserver sem transição vazia; TTL não renovado por falha/prévia. | Implementado e verificado internamente |
| 15/10/2026 | Cache diário e agenda por categoria | Chromium/IndexedDB: cold uma leitura completa por tipo, reload dentro de 24h zero, vencimento uma por tipo, offline preserva dados/idade, conta B sem favoritos da A. Jogos somente em `__games`, home zero consultas de agenda. | Verificado com API sintética |
| 15/10/2026 | Jobs independentes no Supabase | Migração `20261015150309` aplicada; 20 verificações SQL, 23 testes do coletor; leitura real: Séries avançou para 24 páginas/1.012 ocorrências enquanto Filmes estava em publicação. | Aplicado; importação VOD ainda em curso |
| 15/10/2026 | Transporte web privado para TV sem Android implícito | 44 testes locais de HTTP/RPC, cancelamento, headers, biblioteca e sessões independentes; [contrato](wplay-playback-contract.md) atualizado. | Implementado; transmissão real ainda não confirmada |
| 15/10/2026 | Diagnóstico remoto da publicação de Filmes | Tempo cumulativo: montagem JSON 15.833 ms, mídia 17.087 ms, demais fases consomem o restante do orçamento. Separação da preparação privada em implementação; não aumentar timeout por hipótese. | Gargalo medido; correção em andamento |
| 15/10/2026 | Preparação privada separada da publicação | Migração `20261015151331` aplicada; 36 verificações SQL e 24 testes do coletor. JSON privado de 18.612 filmes confirmado. Nova medição: gravação de mídia variou para 50.657 ms e consumiu o orçamento antes do snapshot. | Preparação confirmada; publicação exige índices em lotes |
| 15/10/2026 | Suíte JavaScript integrada | 910 testes: 909 passaram, zero falhas, um skip de symlink no Windows; 23,5 s. Após ajuste final de busca parcial/mensagens, 21 testes do contrato passaram. | Concluído |
| 15/10/2026 | Biblioteca real na interface | Chrome isolado + Auth/SELECT/Realtime reais do Supabase: `37 favoritos`, 37 cards, status sincronizado, zero exceções JavaScript. API de sessão do provedor simulada; gravações pessoais bloqueadas e sessão de teste revogada. | Confirmado para biblioteca; não é prova de catálogo VOD completo ou mídia real |
| 15/10/2026 | Revisão preservada no caminho completo real | Corrigidos `mergeCatalogPage` e `CloudRuntime.#read`: header de publicação acompanha API, preparação e IndexedDB. Regressão com revisão antiga e API completa de 181 itens; 67 testes direcionados passaram. | Implementado e revisado independentemente |
| 15/10/2026 | Índices por geração e Realtime compacto | Migração `20261015152804` aplicada: cópias de até 256 títulos ocultas por RLS, confirmação atômica via header/registry e limpeza limitada. 75 verificações SQL passaram; cliente assina o registro compacto depois do DDL, com 55 testes direcionados. | Aplicado e verificado |
| 15/10/2026 | Publicação real de Séries | Snapshot completo confirmado às 15:44 UTC, publicado às 15:37 UTC: 8.124 títulos, 8.118 seguros; job concluído. TV permanece com 760 títulos completos. Filmes: 18.612 normalizados/preparados, ainda sem snapshot completo. | Séries/TV completos; Filmes em curso |
| 15/10/2026 | Publicação e leitura integral real dos três domínios | Filmes publicado às 15:51:37 UTC: 18.612 títulos / 18.211 seguros. Séries: 8.124 / 8.118; TV: 760 / 659. Verificador autenticado confirmou contagens SQL/API integral, filtro adulto e isolamento. | Três catálogos completos |
| 15/10/2026 | Interface com Séries/TV completos reais | Chrome isolado, Auth/biblioteca/metadados Supabase reais; 8.118 séries e 659 canais disponíveis com bloqueio adulto, 34/37 categorias visíveis, montagem inicial de 48 cards e zero erros JavaScript. Biblioteca atual restaurou 48 favoritos. Sessão do provedor simulada; nenhuma escrita pessoal. | Leitura real confirmada; mídia continua pendente de validação final |
| 15/10/2026 | Migração de cache local | Registros versão 2 invalidam o formato anterior sem apagar biblioteca ou outbox; só resposta completa aceita substitui o registro legado. Versão futura não é rebaixada. 21 testes de cache passaram. | Implementado e verificado |
| 15/10/2026 | Módulo de registro SkipDB/IntroDB | Migração `20261015155746` aplicada; função `series-markers-sync` publicada mantendo autenticação existente. Painel com fontes, cobertura, séries identificadas, falhas e histórico. SQL 28, coletor/fallback 30, integração HTTP/runtime 39 e UI 17 verificações passaram. [Contrato](skipdb-markers.md). | Implementado; leitura real integrada em conferência |
| 15/10/2026 | Separação consultável dos domínios no Supabase | Migração `20261015154822`: nove views `security_invoker` para mídia/categorias/cache de Filmes, Séries e TV, com somente SELECT e geração visível. Fixture ampliada para 122 asserções aprovadas. | Aplicado e verificado remotamente |
| 15/10/2026 | Suíte integrada após o módulo de sincronização | 938 testes: 937 passaram, zero falhas, um skip de symlink no Windows; 29,8 s. | Concluído |
| 15/10/2026 | Leitura integral concorrente em lotes internos | TV 760/659 em 1.504 ms; Séries 8.124/8.118 em 7.022 ms; Filmes 18.612/18.211 em 17.054 ms. Montagem única por geração, total de 21.348 ms incluindo verificações SQL. 47 testes passaram. Não há paginação na navegação do usuário. | API real confirmada; interface integrada em conferência |
| 15/10/2026 | Cobertura de marcadores pré-calculada | Migração `20261015162134`: resumo por IMDb renovado a cada cinco minutos, commit atômico e horário explícito. 37 verificações SQL; RPC real autenticada retornou em 894 ms, substituindo agregação de 9.488 ms que excedia a leitura. | Aplicado e verificado; histórico preserva falhas reais |
| 15/10/2026 | Nova etapa: cálculos por RPC e busca de três caracteres | Responsáveis: catalog_completion (SQL/índices), sync_registry_ui (cliente/cache), sync_registry_backend (auditoria/home), principal (API, integração e verificação). API inicial: 22 testes de autenticação, limites, cancelamento e escopo passaram. | Em implementação integrada |
| 15/10/2026 | Busca e navegação calculadas no Supabase | Migração `20261015164720` aplicada; 38 asserções SQL. JWT real: primeira busca 2.413 ms, seguintes 338–576 ms. Modelos completos conferidos para 18.211 filmes, 8.118 séries e 659 canais com bloqueio adulto. [Contrato e medições](catalog-query-models.md). | Aplicado e verificado remotamente |
| 15/10/2026 | Busca, modelos de catálogo e home no cliente | 44 testes direcionados e três verificações Chromium: mínimo de três caracteres, debounce de 300 ms, cancelamento, ordens/gêneros provenientes do SQL, troca de domínio e upgrade IndexedDB com zero downloads de catálogo e idade inalterada. | Verificado com API sintética |
| 15/10/2026 | Suíte integrada de estabilização, registro e RPC | 984 testes: 983 passaram, zero falhas, um skip de symlink no Windows; 12,3 s. Inclui autenticação, cancelamento, troca de conta, tombstones, cache, transporte e interface. | Concluído |
| 15/10/2026 | Home privada por RPC | Migrações `20261015164721` e `20261015170123` aplicadas/registradas; preparação em lotes concluída. 35 asserções SQL. Plano ajustado somente nessa função: consulta completa medida em 1.162 ms; JWT real em 5.060 ms inicial e 1.316 ms seguinte. [Contrato](home-library-rpc.md). | Aplicado e verificado |
| 15/10/2026 | Gêneros em UTF-8 | Migração `20261015164722` e transporte SQL corrigiram rótulos de seis modelos, sem reconstruir catálogo. 40 asserções SQL e conferência remota dos caracteres. | Concluído |
| 15/10/2026 | Interface integrada com Supabase real | Chrome isolado restaurou os 90 favoritos atuais e abriu Filmes 18.211/36 categorias, Séries 8.118/34 e TV 659/37; 48 cards montados inicialmente por domínio. Busca de dois caracteres fez zero chamadas; “game” retornou 68 resultados em 912 ms. Home retornou 30 recomendações em 1.854 ms. Registro SkipDB/IntroDB exibiu dados reais; zero exceções JavaScript e nenhuma escrita pessoal. Sessão de teste revogada. | Passou; validação final da experiência pelo usuário |

O teste integrado usa Auth, biblioteca, Realtime, metadados completos e RPCs reais do Supabase. Sessão e chamadas auxiliares do provedor são simuladas nesse navegador isolado; capas remotas e transmissão de vídeo não foram certificadas por essa prova. As capturas privadas em `.local/` mostram layout, categorias, gêneros e registro, com placeholders de arte onde a API simulada não entrega imagens. A transmissão real WPLAY permanece parte da validação final do usuário.

Após as verificações, o servidor local foi reiniciado uma vez. `http://localhost:4173` e `/api/session` responderam 200; a busca sem login respondeu 401, e o módulo novo de busca foi servido com debounce de 300 ms. O reinício encerrou a sessão local do provedor; a próxima entrada exige login normal. O servidor e o Chrome isolados de testes foram encerrados; o aplicativo permanece disponível na porta 4173.

## Ajuste posterior: categorias e reprodução adulta

Solicitação seguinte do usuário: abrir Filmes/Séries em Favoritos quando houver títulos salvos; caso contrário, em Lançamentos. Ordem fixa Favoritos → Lançamentos → Todos, demais categorias em ordem alfabética e Adulto ao final. Remover criação de categorias e impedir qualquer histórico de reprodução adulta, mesmo depois do PIN `0000`.

Divisão: `sync_registry_ui` implementa navegação, seleção inicial e integração do player; `sync_registry_backend` implementa proteção e limpeza no Supabase; `catalog_completion` revisa os fluxos de episódios, retomada e home, e os casos de corrida; principal integra biblioteca, fila, cache e validação final. Os favoritos existentes são preservados. TV mantém Favoritos → Todos, sua categoria Jogos de hoje e Adulto ao final, sem criar lançamentos artificiais de canais.

| Alteração | Evidência |
| --- | --- |
| Bloqueio de histórico no navegador | MediaLibrary, EpisodeProgressStore, CloudLibrary, normalização e outbox verificam classificação positiva no título, registro e episódio. Reclassificação limpa histórico/episódios/fila e respostas atrasadas não restauram dados. PIN liberado não altera essa regra. |
| Proteção no Supabase | Migrações `20261015171124` e `20261015172532` aplicadas e registradas. Trigger recusa INSERT/UPDATE adulto, RLS oculta reclassificados, limpeza interna limitada a 500 registros por ciclo de cinco minutos. Favoritos não são apagados. |
| Verificação SQL real | 63 asserções no fixture PostgreSQL; transação remota revertida confirmou três recusas, uma por tipo, além da restrição do job. Conferência: 13 progressos, 92 registros de favoritos (90 ativos), zero progressos adultos confirmados; limpeza inicial removeu zero. |
| Plano da home | Lookup por chave tem opções locais próprias e metadados são materializados após selecionar até 150 resultados. JWT real: 5.086 ms primeira chamada e 1.537 ms seguinte, 30 recomendações e nenhum adulto em histórico/recomendações. Sessão temporária revogada. |
| Disponibilidade local | Servidor já existente na porta 4173 entrega HTML e módulos atualizados com HTTP 200 e `no-cache`. A sessão local do usuário foi preservada nesta etapa; não houve reinício do servidor principal. |
| Navegação no navegador | Fixture Chromium passou com/sem favoritos, chegada tardia da biblioteca, seleção manual preservada, Lançamentos nativo ou oculto, PIN, reclassificação tardia e novo bloqueio/desbloqueio; zero exceções JavaScript. Cache IndexedDB manteve idade e zero redownload. |
| Suíte integrada final | `node --test tests/*.test.mjs`: 1.015 testes, 1.014 passaram, zero falhas, um skip de symlink no Windows; 5,6 s. Log privado `.local/category-privacy-suite.log`. |

Detalhes: [navegação](catalog-navigation-privacy.md), [fluxos do player](adult-playback-privacy.md) e [política no Supabase](adult-progress-privacy.md). As fixtures usam navegador e conta de teste isolados; não acessam o navegador pessoal. A inspeção final da experiência pelo usuário permanece separada dessas provas internas.

## Revisão posterior: precisão das aberturas e créditos

O usuário relatou limites de abertura incompatíveis com a reprodução e pediu revisão integral de Game of Thrones e Vikings, seguida por One Piece anime/adaptação, Os Anéis de Poder e O Senhor dos Anéis. A equipe separou pesquisa das fontes, identificação do catálogo, coleta prioritária no Supabase e aplicação pelo player. Resultados de API continuam referências até existir prova da edição; consulta concluída não equivale a verificação audiovisual.

Falha confirmada: a integração anterior aceitava `community-reference` pela proximidade de duração; também podia criar botão manual com evidência sem runtime e combinar interseções de fontes. Esses caminhos não comprovam os limites no vídeo WPLAY. Foram removidos da execução; referências permanecem diagnósticas. O padrão compartilhado de reprodução agora é `markers`, com avanço no evento real `ended` quando não há créditos conferidos. Preferências de offset já salvas são preservadas.

Foram conferidos os inventários públicos integrais e variantes do dump para as obras, além de amostras independentes de IntroDB. Os 162 episódios regulares de GoT/Vikings estão enumerados no relatório. Anime e adaptação de One Piece têm IMDb/ano distintos; o anime também possui agrupamentos incompatíveis entre fontes e entre as ofertas WPLAY. Resolvedores rejeitam homônimos e conflitos de ano/IMDb/TMDB, preservando IDs nativos e variantes de idioma.

A fonte WPLAY autorizada permitiu inventariar 73 episódios GoT, 88 Vikings principais, 9 Vikings LEG, 875 rótulos One Piece principais/1.180 LEG, 16 da adaptação e 16 de Os Anéis de Poder. O cabeçalho MP4 de três arquivos foi medido. Quadros reais de GoT T5E1 delimitam a transição de abertura entre 113 e 117 s, sem certificar um segundo exato; tentativas de quadros posteriores foram interrompidas por HTTP 429. Os processos temporários de mídia foram encerrados. Nenhuma senha/URL privada foi gravada no relatório, e nenhuma edição foi promovida a verificada por duração ou por essa observação parcial.

Evidências: [auditoria de fontes](../reports/marker-source-audit-2026-10-15.md), [ofertas e mídia WPLAY](../reports/wplay-marker-edition-audit-2026-10-15.md), [estado do envio remoto](marker-target-audit-2026-10-15.md) e [contrato do player](marker-playback-verification.md). A conferência audiovisual de todos os arquivos permanece pendente, sem tratar milhares de respostas de API como milhares de vídeos verificados.

| Entrega desta revisão | Verificação |
| --- | --- |
| Contrato e interface do player | 79 testes focados; Chromium isolado com módulos/manifests reais e mídia simulada confirmou bloqueio comunitário, detalhes lazy, próximo episódio manual, espera por `ended`, avanço único e marcação manual por clique. Zero exceções JavaScript/console.error. |
| Fonte e fila global | Migração `20261015182553` aplicada/registrada e Edge republicada. O plano de nove vínculos nativos e 1.387 referências recebeu HTTP 201 no envio da transação, mas sua persistência e execução não foram confirmadas: o readback REST excedeu 10 s e até `SELECT now()` retornou HTTP 544. Os relatórios mantêm `applied:false` e contagens persistidas/concluídas nulas. Não reenviar sem conferir o lote anterior. Prioridades por obra, prazos próprios e comparação de revisão foram verificados nos fixtures. Nenhuma promoção audiovisual foi realizada. |
| Suíte integrada | `node --test tests/*.test.mjs`: 1.031 testes, 1.030 passaram, nenhuma falha, um skip de symlink no Windows; 6,0 s. `.local/marker-edition-suite.log`. |
| Aplicativo em execução | HTML e quatro módulos conferidos com HTTP200, incluindo guarda e default compartilhado. Servidor principal preservado; processos temporários de mídia e da interface encerrados. |

## Correção seguinte: recuperação da TV e publicação do projeto

Três frentes revisaram transporte, cliente e EPG a partir das capturas de Megapix. Foram corrigidos o prazo inicial incompatível com a preparação OTT, RPCs de abertura não cancelados, disputa GET/HEAD do mesmo canal, callbacks HLS atrasados, erro visual prematuro e descarte de programação ainda vigente. [Revisão integrada e evidências](live-playback-recovery.md).

Depois do congelamento dos três agentes, a suíte final passou com1.053 testes:1.052 aprovados, zero falhas e um skip de symlink no Windows. Bundle/licenças e79 imports da interface conferidos; Chromium isolado não teve exceções. Backend reiniciado uma vez às19:08:58 UTC, com módulosHTTP200/no-cache e acesso sem conta à mídia recusado401. O login local precisa ser refeito após esse reinício. Reprodução real prolongada continua sem certificação por essa prova sintética.

A revisão de publicação inclui todas as atualizações de código/documentação e verifica ausência de credenciais reais nos arquivos selecionados. O [registro da versão](release-2026-10-15.md) separa as entregas das pendências: Supabase com serviçosUNHEALTHY no último health check, lote de1.387 referências sem readback e ausência de certificação audiovisual em massa. Processos temporários foram encerrados, e o servidor principal permanece na porta4173.
