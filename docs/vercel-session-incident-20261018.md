# Entrada aceita e sessão perdida na Vercel

Data: 18/10/2026. Estado: correções distribuídas publicadas; entrada, Filmes, Séries e capas conferidos no Safari online após recuperação do Supabase. As publicações anteriores READY não certificaram o fluxo. Evidências e etapas abaixo têm escopos e horários próprios.

## Evidência do incidente

As capturas fornecidas pelo usuário mostram a preparação do acesso seguida de retorno à entrada com a mensagem de sessão encerrada.

Foi consultada uma janela explícita de 12:42–12:52 UTC (09:42–09:52 BRT) do projeto Vercel ARKHEN. O conector respondeu 403 aos registros de execução; o fallback autenticado da CLI, com o mesmo projeto e equipe, conseguiu ler os metadados das requisições. Não se trata de ausência de logs. O resumo abaixo conserva somente rota e código HTTP, sem cookies, query strings, cabeçalhos, credenciais ou identificadores pessoais.

| Tentativas observadas entre 09:47:17 e 09:47:32 BRT | Respostas |
| --- | --- |
| `POST /api/login` | 3 × 200 |
| `GET /api/parental` | 3 × 200 |
| `GET /api/catalog` | 3 × 200 e 6 × 401 |

A implantação de produção estava `READY` no commit `321bdff`. Os três logins foram aceitos pela aplicação; o erro ocorre nas leituras posteriores. Os registros não mostram cookies, payloads ou o identificador interno do processo, portanto não isolam a distribuição exata de cada requisição entre instâncias.

## Causa arquitetural identificada

`lib/app-server.mjs` cria um `Map` de sessões em cada `createApp()`. O cookie `ORBIT_SID` é apenas uma chave para esse Map. Se a requisição chega a um processo que não possui aquela chave, `browserSession()` cria uma sessão anônima e troca o cookie. A guarda `SESSION_REQUIRED` então recusa o catálogo, e `web/login/session-guard.js` encerra corretamente o estado autenticado da interface.

O processo do servidor também possui objetos de provedor, tokens, fontes privadas, controle parental, assets de mídia, intenção de reprodução e callbacks de parada. Compartilhar somente o nome do usuário ou o status de login não preserva esses contratos. Repetir a senha no navegador, desativar a guarda ou tratar 401 como sucesso não corrige a sessão.

As [orientações oficiais da Vercel sobre estado de serviços](https://vercel.com/kb/guide/vercel-services-fluid-compute) exigem um armazenamento externo para estado compartilhado entre instâncias. Os limites de sessões por processo já estavam registrados no [incidente local de sessão](session-loss-reconciliation-20261017.md) e na seção de hospedagem do README.

## Correção usando Vercel e Supabase

A instrução do usuário mantém somente Vercel e o Supabase autorizado `wnicimkmzswksaqdtgdv`. A WPLAY continua fornecendo autenticação, catálogo e transmissão. Não há serviço Node externo, contêiner, VPS ou hospedagem de vídeo no Supabase.

`RuntimeSessionStore` usa cookie opaco `ORBIT_SID` com Secure/HttpOnly/SameSite=Strict e validade de 24 horas. O SHA-256 desse identificador seleciona uma linha privada. O estado necessário para reconstruir o cliente, incluindo tokens/credenciais do provedor e autorização parental, é comprimido e cifrado com AES-256-GCM, nonce aleatório e AAD vinculada à sessão. O segredo para derivar a chave fica somente no ambiente confiável: HMAC do segredo do gateway, ou da chave de servidor no modo direto legado. Rotacionar essa credencial invalida os estados cifrados existentes. Biblioteca e progresso continuam nas estruturas pessoais anteriores; mídia e caches de bytes não entram no checkpoint.

Uma lease de 90 segundos, renovada enquanto há operação, usa owner, fence monotônico e revisão para impedir que uma instância antiga sobrescreva logout, troca de conta ou reprodução. O estado tem expiração fixa de 24 horas, limpeza indexada limitada a oito registros vencidos por aquisição e ausência de permissões anon/authenticated. As quatro RPCs são SECURITY INVOKER, search_path vazio e execução exclusiva service_role. Não há consultas a logs nem novo cron.

Cada requisição restaura objetos privados sem autenticar novamente. Resultados JSON e imagens aguardam checkpoint antes de sair; sid/generation são preservados antes de START e assets de manifests antes da resposta. Corpo de vídeo libera a lease antes do streaming para permitir segmentos e STOP. Nenhum checkpoint tardio depois desse release pode reviver uma sessão encerrada. Falha do armazenamento retorna 503; não é tratada como senha inválida ou logout confirmado.

A geração privada de mídia permite cancelar leitores locais imediatamente após mudança confirmada e consultar revogação entre instâncias. Durante corpos longos ativos, uma consulta mínima por chave ocorre a cada 2,5 segundos, com timeout de 1,5 segundo; não é polling de logs. A latência inclui consulta e agendamento, portanto não há garantia de cancelamento em no máximo 2,5 segundos. Erro da consulta interrompe o corpo por segurança. O STOP remoto WPLAY continua preservado.

## Configuração e ativação

A migration `20261018132540_arkhen_private_runtime_sessions.sql` cria `arkhen_private.runtime_sessions` e as RPCs acquire/renew/commit/media. A função nova `arkhen-session` aceita somente essas quatro operações, com HMAC entre servidores e origem Supabase fixa; `verify_jwt=false` é acompanhado de assinatura obrigatória e rejeição de Origin de navegador. Ela usa as chaves administrativas já gerenciadas pelo Supabase e `ARKHEN_BACKEND_SECRET`. As outras funções permanecem inalteradas.

Na Vercel, `ARKHEN_SUPABASE_CONFIG` é uma variável sensível somente de produção. O contrato existente aceita `{url,publishableKey,gateway:{secret}}` ou o modo legado `{url,publishableKey,secretKey}`. O primeiro envia as quatro operações à Edge dedicada; o segundo usa REST com a chave privada apenas no servidor. A configuração local atual usa o modo direto; o usuário autorizou explicitamente transferi-la à variável privada de produção. Nenhum valor entra no repositório ou no navegador. O runtime hospedado não lê `.local`.

Localmente, o Map e o transporte existentes continuam inalterados. No modo Vercel o worker ligado ao tempo de vida do processo fica desativado: aposentar uma instância não revoga a identidade ou a sessão remota reconstruída em outra instância.

## Evidência e limites

Revisão independente de SQL, Edge, criptografia, snapshots, concorrência, cancelamento, headers e backoff; checagens de sintaxe e diff. Schema aplicado pela Management API, Edge publicada por CLI com project-ref explícito. Readback às 13:48:19 UTC confirmou RLS ligada, nenhum SELECT anon/authenticated e as quatro funções invoker executáveis somente por service_role. A função `arkhen-session` está ACTIVE versão1, com autenticação HMAC e segredo presente (somente nome conferido). A configuração sensível da Vercel foi provisionada com autorização explícita. O primeiro readback SQL falhou por connection timeout; uma amostra posterior encontrou nove conexões, seis clientes ociosos e zero temporários. Saúde DB/Auth/REST positiva nessa leitura não descarta os504 das capturas nem prova recuperação sustentada. Métricas de sistema retornaram403; nenhuma tentativa com outra chave foi feita. Não foram feitos testes, navegação automatizada, login real ou transmissão. Deploy`dpl_mqPcwEgzF37L9zrje9wqxq899YdS`, commit`523c8b147dcbea6e6dfe33cbb5989419cb368c9d`, confirmado READY e alvo de produção via CLI autenticada. Instalação e status READY não certificam a experiência de reprodução nem eliminam os limites de duração/transferência da Vercel.

Fontes: `lib/runtime-session-store.mjs`, `lib/runtime-session-state.mjs`, `lib/runtime-session-context.mjs`, `lib/app-server.mjs`, `lib/supabase-cloud.mjs`, hooks privados dos provedores WPLAY e a migration/função indicadas. Referências: [estado de serviços Vercel](https://vercel.com/kb/guide/vercel-services-fluid-compute), [deploy de funções Supabase](https://supabase.com/docs/guides/functions/deploy), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).


## Catálogo 503 após a sessão distribuída: causa confirmada

Janela Vercel14:21:21–14:24:21UTC (11:21–11:24BRT), produção48675cf: diagnóstico sanitizado mostrou `RUNTIME_SESSION_TOO_LARGE` no catálogo e `RUNTIME_SESSION_BUSY` em requisições concorrentes de Home, grade, revisão e sessão. A sessão pôde responder200/connected/ready, e uma leitura isolada do catálogo TV devolveu JSON. Isso não certifica o carregamento da página completa. As capturas posteriores mantêm falhas503 e diferenças entre localhost e produção.

O DTO parental copiava objetos completos dos catálogos, incluindo apresentação e descrições. O checkpoint cifrado excedia o teto3MiB, impedindo entregar o JSON que já estava pronto. O catch ainda repetia a captura/compressão inviável antes de liberar a lease, ampliando a espera das outras chamadas. O Map local não passa por esse teto, explicando a divergência observada sem atribuí-la a credenciais WPLAY recusadas.

A correção exporta provas mínimas por título/categoria, vínculos episódio→série e imagem→proprietários. Mantém classificação, negação de desconhecidos, PIN/cooldown e o lookup autorizado. Snapshots anteriores são compactados na restauração. A serialização ocorre uma vez por checkpoint; tamanho inválido não provoca recaptura, e requisição já cancelada não adquire lease. Diagnóstico informa somente código, fase, bytes e teto. Limites e RPCs não foram ampliados; cálculo de recomendações permanece no banco.

Validação local dirigida:19 testes sintéticos passaram, incluindo fixture20mil títulos (12mil Filmes/8mil Séries) com metadados aleatórios: antigo>3MiB, novo≈1,23MB. Roundtrip com cliente WPLAY real sem rede preservou episódio autorizado; teste de duas instâncias preservou ambas as alterações e liberação da lease. Verificou-se descarte de falso200 em falha de persistência. Não houve reprodução de vídeo. Esta fixture preenche o parental; não mede catálogos privados grandes nos hooks `rawItems`/`nativeVOD` do fallback, que continuam um limite separado. Confirmação do deploy e do fluxo online deve ser registrada após a operação real.


## Contenção restante e leituras paralelas

Depois do deploy86ce2d2 READY, uma abertura real ainda falhou: janela14:34:12–14:37:12UTC registrou BUSY no catálogo, grade, revisão, readmodel e sessão da nova implantação. Nessa amostra não apareceu TOO_LARGE. A lease permanecia exclusiva durante consultas e recuperação/download de capas; compactar o DTO isoladamente não resolvia essa fila.

A segunda correção mantém autenticação/revalidação e ações mutáveis sob lease, libera antes das leituras cloud explicitamente permitidas e conserva a resposta em buffer. O epoch inclui conta/provedor, geração autenticada, estado/expiração da conta, PIN e reprodução opcional, funcionando também sem vídeo. Uma validação remota obrigatória antes de flush e a guarda durante IO impedem entregar resultados antigos após mudança confirmada. Não há checkpoint após liberar. Negativa explícita401/403 invalida a geração e sessão do provedor; erro transitório não é promovido a negativa. A ausência temporária de Auth cloud não integra o epoch de reprodução.

Leituras permitidas: GETcatalog semrefresh=1, readmodel, revision e guiaTV; POSTHomebiblioteca e HomeTV após guarda de entrada. Heartbeat, fontes, detalhes, reprodução, login/logout, PIN e refresh explícito permanecem exclusivos. Fallback ao provedor e recoveryAuth401 são recusados depois da liberação; connect não pode reautenticar nesse contexto. Catálogo ausente continua erro503, sem falso catálogo vazio. O ranking continua nas RPCs existentes.

Capas compartilhadas consultam todos os proprietários da referência (consulta indexada limitada, no máximo64referências; até3batches por tipo), mesmo havendo uma prova parcial já carregada. Classificação incompleta, ambiguidade, excesso ou falha de transporte recusam a resposta. O lookup aplica JWT/RLS da geração publicada. A leitura ocorre fora da lease, sob a validação final de conta/PIN; imagens privadas registradas ainda autorizam antes de liberar.

O usuário autorizou explicitamente testes e navegador durante esta etapa, revogando a proibição anterior. Os testes HTTP foram inicialmente impedidos pelo sandbox/revisão automática; somente após a autorização foram executados com fixtures127.0.0.1. Testes específicos do store cobrem concorrência entre instâncias sem vídeo, descarte de mutações pósrelease, preservação de escritor posterior, revogação por PIN/logout/geração e erro da validação sem flush de200/Location. A comprovação do deploy e da página real desta segunda etapa ainda deve ser registrada.


## Indisponibilidade compartilhada às11:56–11:57BRT

A segunda correção foi publicada no commit2a42ea151881f1ef3b9b67afe4ceee62efc3698f; deploymentdpl_ARk1WPheKUWm2EzKpgWNurdNpoPK READY e alvo de produção conferidos.74testes dirigidos passaram, incluindo9HTTPsintéticos. Isso não certificou a disponibilidade remota: a tentativa real ainda mostrou503 em session/login.

Janela14:54:00–14:57:30UTC: diagnóstico da nova implantação indicou `RUNTIME_SESSION_UNAVAILABLE`, faseacquire, transporte`CLOUD_TIMEOUT`. Captura local11:57BRT mostrou também504 no endpointAuth de renovação do Supabase, além dos503 das capas. A leitura de saúde oficial retornou DB/Auth/RESTUNHEALTHY; a consulta administrativa limitada retornou544/connectiontimeout. A indisponibilidade comum está demonstrada, mas não identifica CPU, autor de reinício ou consulta causadora.

O usuário autorizou expressamente reiniciar o projeto ARKHEN. A chamada administrativa foi recusada403, faltando`project_admin_write`; não foi contornada com chave de serviço ou modificação de permissões. O painel autenticado do projeto já apresentava Restarting, sem clique de reinício executado pelo agente. A recuperação e a validação do fluxo permanecem pendentes desta etapa.


## Recuperação e conferência real após12:04BRT

O projeto passou a ACTIVE_HEALTHY; a leitura oficial confirmou DB/Auth/REST saudáveis. Estatística agregada às15:04:09UTC encontrou postmaster iniciado15:01:57UTC,24backends,2outros ativos, nenhum esperandoLock, duas sessões privadas, maior ciphertext7.329bytes e nenhuma lease ativa. Não houve leitura de payload cifrado, credenciais ou SQL pessoal. Essa amostra demonstra recuperação pontual, não a causa da indisponibilidade nem estabilidade permanente.

No Safari, o agente clicou Entrar no formulário de produção já preenchido. A entrada foi aceita; a rota/#movies carregou categorias e capas com18.211títulos, e/#series exibiu categorias e capas com8.118títulos. Nenhum dado de favoritos/progresso/conta foi copiado para esta memória. JanelaVercel15:05:04–15:08:04UTC retornou zero registros503 na consulta final limitada. Houve inspeção visual de catálogo; nenhuma reprodução de mídia foi iniciada por essa conferência.

O localhost também exibiu novamente categorias e capas após a recuperação. Seu processo antigo foi encerrado com SIGTERM após confirmar PID/porta/diretório; `node server.mjs` iniciou a versão publicada na porta4173. Como as sessões locais continuam em RAM por contrato, o formulário passou a exigir entrada; a senha ficou vazia e foi solicitado preenchimento diretamente no Safari, sem enviar senha ao chat. A nova entrada local permanece pendente até esse preenchimento.

## TV local com quadros e TV online sem primeiros quadros às12:20–12:22BRT

As novas capturas do usuário demonstram reprodução local1080p e preparação online com0s disponíveis. A grade carregada não comprova mídia. A leitura única Vercel15:19:00–15:23:30UTC retornou50registros:27x503,22x200,1x502; TV teve play/live200 e503, assets502/503, com BUSY/UNAVAILABLE do runtime. Na janela menor15:18–15:21UTC, quatro falhas de capa eram BUSY. Saúde DB/Auth/REST estava normal. Não há prova de rejeição WPLAY ou de falha de codec nessa amostra.

A liberação antecipada anterior ainda dependia de adquirir a lease antes do preludeAuth. Nova RPC privada `arkhen_runtime_session_read` lê o checkpoint comprometido por MVCC sem tomar/renovar lease. Retorna cipher/epoch da mesma leitura. Novo allowlist de rotas usa snapshot somente para metadata compartilhada com cloud, imagens privadas e status; segmentos exigem registro, duração positiva e chave de playback correspondente. Manifests/chaves, seleção de fonte, detalhes, refresh explícito, Auth/STOP/PIN continuam writers. Prelude readonly usa prova válida existente, sem bootstrap/reautenticação; validação remota obrigatória antecede flush/headers e a guarda de epoch permanece durante streaming. Null epoch legado faz upgrade exclusivo. Snapshot leitor nunca é persistido.

Somente falha upstream de segmento adquire uma lease curta: restaura DTO fresco, verifica epoch/cipher e mescla cooldown/failure com CAS. Erros não podem sobrescrever conta/PIN/seleção mais recentes. Segmentos bem-sucedidos não escrevem. Playlist inesperada no caminho somente segmento é recusada antes de registrar assets perdidos.

Migration20261018152631 aplicada e privilégios conferidos: invoker, stable, search_path vazio, anon/authenticated sem EXECUTE, service_role permitido. Gateway Edge atualizado com envelope assinado e DTO estrito. Testes dirigidos cobriram20leitores durantewriter, zeroaquisições/capturas/commits extras, selectorfalse restaurando estado fresco, revogação antes de200/Location, guardastream e cooldown. Deployapp e reprodução real desta correção ainda pendentes nesta entrada.

Commitdaa16bc implantado READY emdpl_HiBGVXkuy2uoCgL8WgSzKDiBmPaL e alvo de produção conferido. Janela15:40–15:47UTC:47x200/3x503, semBUSY; falhas MEDIA_REVOKED em metadata, sem tentativa de vídeo nessa amostra. Leitores buffered passam a registrar revogação local e validar remotamente antes do flush, sem polling durante a consulta; polling remoto continua obrigatório ao transmitir.22testes do store passaram;18roundtrips dos três clientes reais (19testes com agrupador) preservaram epoch no estado estável.

Teste Safari em janela separada às12:56BRT: fonte200, manifestos409 três vezes, grade/status200, sem segmentos. JanelaVercel única15:55:50–15:57:15UTC confirmou essa sequência, sem502/503. Não prova WPLAY recusando a conta nem reprodução recuperada. Saídas silenciosas dos guards409 recebem enumeração sanitizada para distinguir geração/conta/cliente, abort do leitor, source e intent, sem URLs/sid/attempt. A confirmação audiovisual permanece pendente.

O callback playbackError estava habilitado somente na execução local;9f965b2 habilitou o diagnóstico sanitizado também no import hospedado. Uma tentativa controlada13:14BRT/16:14:24UTC registrou `LIVE_SOURCE_CHANGED`. Esse código vem de selectLiveSource quando o ID solicitado não existe no inventário reconstruído, antes do manifesto. Não era um guard de geração ou um erro de login. A versão anterior calculava o ID web incluindo URL de transporte completa, embora item/variante já tenham identidade estável do provedor. Reconstrução entre instâncias pode renovar essa URL.

Fontes web com raw-key/itemId passam a usar canal+origem+item+variante+rótulo+qualidade; a URL atual permanece privada no entry. Demais origens e web sem identidade conservam o hash legado exato. Fonte ausente/ambiguidade não recebe fallback silencioso. Testes sintéticos rodam endereço/token/host/caminho mantendo a seleção da variante atual e distinguem canal/rawID/itemID/rótulo/qualidade. IDs web antigos precisam renovar a lista uma vez após publicação. Confirmação do novo deploy e dos quadros online ainda pendente.

## Reprodução online confirmada às13:40–13:41BRT

Commitfbe5a4f278d09e3deb47bad7debdb6ce52e07832 publicado no GitHub; deploymentdpl_9cMkYUXpf8VLPYQbEr5tHGW7a2hv READY e alvo de produção conferidos.45testes WPLAY dirigidos passaram. No Safari, uma janela separada renovou o inventário e abriu o canal002 às16:35:29UTC. Houve preparação ainda com0s aos41s; portanto, não se certifica abertura rápida nem se mede aqui o instante do primeiro quadro.

Na mesma reprodução e URL de produção, duas observações visuais posteriores mostraram cenas diferentes avançando, sem a tela de preparação. Às13:41:27BRT, a acessibilidade confirmou botãoPausar e resolução **medida1920×1080**, além do programa atual. Essa é prova audiovisual pontual de TV online; não é certificação de todos os canais, das capas ou de estabilidade prolongada. A transmissão de teste recebeu Fechar reprodução ao terminar.

Consulta Vercel única, limitada a16:35:20–16:37:00UTC e ao deployment atual:16manifestos e20assets HTTP200, nenhum403/404/409/502/503. Um asset200 registrou CLOUD_TIMEOUT em readonly_validation; essa validação também ocorre após a transferência, e o registro sozinho não prova truncamento. Não houve consultas de logs Supabase. As guardas de conta/PIN/epoch e recusa de fonte ausente permanecem ativas. Latência inicial e esse diagnóstico residual ficam como limites observados, sem atribuí-los à conta WPLAY ou promover200 a prova de vídeo.
