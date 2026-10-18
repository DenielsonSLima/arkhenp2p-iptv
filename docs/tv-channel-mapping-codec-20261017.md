# Associação de canais com qualificador de codec

Data: 17/10/2026. Estado: correção local, validada por testes sintéticos e consulta autorizada de metadados, ativada no servidor local. Reprodução no Safari continua pendente.

## Causa confirmada

A descoberta de fontes do canal nativo `467`, **HBO Plus**, respondia HTTP 409 com `WPLAY_WEB_CHANNEL_AMBIGUOUS`. A consulta limitada dos dois catálogos confirmou três títulos OTT separados: **Hbo Plus** com SD/HD/FHD, **Hbo Plus H265** com FHD e **HBO Plus LEG** com SD/HD/FHD. São identidades OTT distintas; os objetos não fornecem um campo explícito de identidade nativa compartilhada.

O resolvedor retirava o sufixo de codec `H265` antes de avaliar a identidade. Com isso, os dois primeiros títulos viravam `hbo plus`, causando falsa ambiguidade mesmo havendo um título completo correspondente. `LEG` já era preservado. A falha ocorre na descoberta de fontes, antes de abrir mídia; não é um conflito de favoritos nem uma medição de bitrate.

## Correção restrita

[`resolver-web.mjs`](../lib/wplay/ao-vivo/resolver-web.mjs) conserva os qualificadores reconhecidos de codec durante a análise do rótulo. Sem uma identidade nativa explícita, prioriza os candidatos cujo título completo tem os mesmos qualificadores de codec do canal pedido, ignorando somente os sufixos reconhecidos de qualidade nessa preferência. Só depois aplica a associação conservadora já existente.

A comparação usa `raw.title`, porque `candidate.name` contém também a qualidade da variante acrescentada pelo adaptador OTT. O título **HBO Plus** seleciona somente as variantes da identidade **Hbo Plus**; **Hbo Plus H265** permanece separado. Nenhuma escolha depende da ordem do catálogo. Identidades exatas duplicadas continuam retornando 409, e um ID nativo explicitamente compartilhado conserva precedência. A associação anterior de um único candidato com rótulo de entrega continua disponível quando não existe candidato completo preferível.

IDs de catálogo, favoritos e histórico não mudam. A maior qualidade continua selecionada dentro da identidade associada, e `sourceId` explícito continua pertencendo ao mesmo canal. Não houve mudança de transporte, manifesto, autenticação, cache ou política de recuperação.

## Verificação e limites

A regressão HBO Plus versus H265 falhou com 409 antes da correção e passou depois. Foram verificados 40 testes únicos nos conjuntos `wplay-live-mapping-diagnostic`, `wplay-web-playback`, `wplay-live-source-isolation`, `wplay-live-preparation` e `app-server-live-sources`. Incluem ordem invertida dos candidatos, título com H265 explícito, duplicata exata, precedência de ID compartilhado, separação de regiões/números, namespace das fontes, controle parental e sessão. O transporte sintético confirmou três fontes disponíveis, FHD inicial e seleções explícitas HD/SD permanecendo na mesma identidade OTT. Nenhuma dessas transmissões é mídia real.

Uma nova consulta autorizada de metadados com o módulo corrigido retornou, para 467, sete descritores: quatro fontes nativas TVBus indisponíveis no transporte web e três fontes OTT disponíveis, SD/HD/FHD, com FHD selecionado. Não houve 409. A consulta não abriu manifesto, segmento ou vídeo, nem executou STOP, logout remoto ou reinício do servidor.

Essa prova confirma a associação e a disponibilidade dos descritores naquele momento. Não certifica reprodução audiovisual, resolução recebida, latência de abertura ou estabilidade no Safari. Cookies, credenciais, IDs OTT e endereços privados de mídia não integram este registro.

## Ativação local e impedimento de validação visual

Após autorização explícita do usuário, o coordenador encerrou graciosamente o processo local anterior e iniciou `node server.mjs` com este módulo e as correções de sessão. A conferência de 17/10 às 13:00 BRT encontrou a página com HTTP 200/no-cache e as rotas anônimas de sessão/Home com `SESSION_REQUIRED`, confirmando o backend atualizado. Sessões em RAM precisam de nova entrada após esse reinício.

A rodada integrada final passou com 48 testes de associação, transporte, preparação, isolamento de fontes, recuperação cloud e perda de sessão. A primeira execução foi impedida de abrir loopback pelo sandbox; a repetição autorizada passou sem falhas. Isso não representa um teste de mídia.

O teste pedido no Safari foi tentado, mas o controle remoto retornou repetidamente `Sky Computer Use native pipe startup failed`, inclusive após reset do cliente e nova tentativa solicitada pelo usuário. A ferramenta não enumerava aplicativos ou navegadores. Não foi possível concluir a medição audiovisual no Safari nesta etapa; não substituí-la pelos resultados nativos anteriores.
