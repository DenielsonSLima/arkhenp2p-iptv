# Entrada aceita e sessão perdida na Vercel

Data: 18/10/2026. Estado: correção distribuída implementada; schema e Edge ativados no projeto autorizado. Publicação da aplicação em andamento. Validação estática e leitura de metadados; sem testes, navegador, login ou reprodução.

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

Revisão independente de SQL, Edge, criptografia, snapshots, concorrência, cancelamento, headers e backoff; checagens de sintaxe e diff. Schema aplicado pela Management API, Edge publicada por CLI com project-ref explícito. Readback às 13:48:19 UTC confirmou RLS ligada, nenhum SELECT anon/authenticated e as quatro funções invoker executáveis somente por service_role. A função `arkhen-session` está ACTIVE versão1, com autenticação HMAC e segredo presente (somente nome conferido). A configuração sensível da Vercel foi provisionada com autorização explícita. O primeiro readback SQL falhou por connection timeout; uma amostra posterior encontrou nove conexões, seis clientes ociosos e zero temporários. Saúde DB/Auth/REST positiva nessa leitura não descarta os504 das capturas nem prova recuperação sustentada. Métricas de sistema retornaram403; nenhuma tentativa com outra chave foi feita. Não foram feitos testes, navegação automatizada, login real ou transmissão. Instalação e status READY não certificam a experiência de reprodução nem eliminam os limites de duração/transferência da Vercel.

Fontes: `lib/runtime-session-store.mjs`, `lib/runtime-session-state.mjs`, `lib/runtime-session-context.mjs`, `lib/app-server.mjs`, `lib/supabase-cloud.mjs`, hooks privados dos provedores WPLAY e a migration/função indicadas. Referências: [estado de serviços Vercel](https://vercel.com/kb/guide/vercel-services-fluid-compute), [deploy de funções Supabase](https://supabase.com/docs/guides/functions/deploy), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
