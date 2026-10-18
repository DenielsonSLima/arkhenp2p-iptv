# Autenticação WPLAY

Revisão estática: 16/10/2026. Consulte os identificadores e hashes em [Evidências](evidencias.md).

## Site oficial

**Observado:** o formulário do bundle `auth-C3TbW9Ji.js` envia uma função POST com os campos `identifier` e `password`. Quando a resposta declara autenticação, o cliente instala os tokens de acesso/renovação no SDK Auth usado pelo próprio site. Quando a primeira resposta declara não autenticação, há uma segunda função POST com `username` e `password`. O sucesso navega para `/watch`. Exceção de transporte entra no tratamento de erro; não equivale ao ramo de resposta negativa.

Essas funções são expostas por `wplay.functions-sItkKweF.js`. Seus IDs públicos de login principal e login de compatibilidade continuam iguais aos declarados em `lib/wplay/ott/provedor.mjs` nesta revisão. Isso confirma a correspondência estática; não comprova que uma conta tenha sido aceita agora.

O cliente RPC público constrói a rota `/_serverFn/<id>`, identifica a chamada pelo header `x-tsr-serverFn` e usa a serialização do framework. GET pode transportar `payload`; POST pode transportar JSON serializado. A resposta pode ter `x-tss-serialized` e enquadramento `application/x-tss-framed`. Portanto, chamar esse contrato como um endpoint REST de JSON comum pode falhar mesmo com HTTP 200.

**Correspondência ARKHEN:** `lib/wplay/ott/rpc.mjs` implementa o codec e enquadramento observados. `WplayOTTProviderClient.connect()` envia os mesmos pares de campos e conserva cookies/Bearer somente na sessão backend. Cabeçalhos de autenticação são limitados à origem oficial, sem propagá-los indiscriminadamente para CDN.

## APK Android

**Evidência histórica do mesmo SHA reconferido:** o APK monta POST de formulário URL encoded, normaliza as credenciais e, no fluxo inspecionado, acrescenta o sufixo configurado quando o usuário não contém `@`. O builder também usa identidade real Android e User-Agent próprio; esses campos não provam uma identidade web equivalente.

O seletor do APK diferencia LOGIN, LOGIN_BACKUP e a URL posterior de autorização entregue em `AuthInfo.service`. O critério observado de sucesso é `AuthInfo.code == 0`, além do status HTTP. Os endpoints de serviço, token, catálogo e EPG vêm da resposta autorizada.

Fontes específicas: [contrato de autenticação do APK](../../analysis/WPLAYP2P-11.9.0d-auth-contract.md), DEX `td.m.e` em `0x21a078`, construção do POST em `0x21a3be`, seletor protegido `td.m.i` e resposta `td.m.k`. A [inspeção posterior](../tv-backend-modules-20261016.md) distingue código DEX comum de métodos declarados nativos.

## Regras de integração

- Preservar a origem e os servidores da integração autorizada. A existência de duas URLs no APK não certifica qual está operacional hoje.
- Manter o login do APK e o login web como contratos distintos. Login HTTP aceito não executa nem converte uma biblioteca Android.
- Cada conta mantém sua sessão, cookies, fontes e cancelamento. Resposta antiga não pode restaurar uma conta encerrada.
- A biblioteca Supabase do ARKHEN continua separada. Falha em seu bootstrap não deve trocar credenciais WPLAY, fabricar outro login ou ativar um runtime local experimental.

**Lacunas:** cookies efetivamente emitidos, aceitação da conta, refresh e política atual do servidor não foram medidos nesta revisão; foram lidos apenas consumidores públicos e código local.
