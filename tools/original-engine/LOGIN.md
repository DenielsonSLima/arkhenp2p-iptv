# Login pelo APK original

Ferramenta local de depuração para o **WPLAYP2P 11.9.0d / 1190**, pacote
`io.wareztv.android.one`, já iniciado no emulador. Não instala ou altera o APK,
não cria respostas de autenticação e não modifica a verificação de certificado.

Compilar no diretório desta ferramenta:

```sh
./node_modules/.bin/frida-compile login-agent.mjs -o login-agent.bundle.js
```

Executar `login.py --endpoint 127.0.0.1:PORTA` com o Python que já contém Frida.
A entrada é uma única linha JSON via **stdin**, com `username`, `password` e,
opcionalmente, `timeoutMs` (1–90 segundos). Não passar credenciais por argumentos,
variáveis de ambiente ou logs. A ferramenta só anexa ao PID identificado pelo
pacote exato e exige versionCode 1190.

O fluxo reproduz o submit original: `trim`, sufixo da configuração original
quando o usuário não contém `@`, modo 1, preferências do aplicativo, mensagem 13
para o Handler da Activity. Portanto, **o próprio APK mantém suas preferências
normais de login**. A ferramenta não salva uma cópia delas. O código original
também possui logs de autenticação; não coletar logcat/Xlog indiscriminadamente.

O callback original `td.m.k(int,String,String)` continua recebendo e processando
os argumentos originais. Depois dele, a ferramenta lê o código numérico de
`td.m.d.code`. Também observa o estado original a cada 250 ms, pois no teste real
o login terminou sem que o observador de callback concluísse. Essa observação
exige um objeto `AuthInfo` novo em relação ao início do submit; sucesso exige
usuário e serviço presentes e a conta correspondente à entrada, comparada apenas
em memória. Não aceita uma sessão de sucesso antiga como resultado de um novo
submit. Nenhuma resposta ou estado de autenticação é fabricado.

A saída contém apenas `authenticated`, `code` e indicadores booleanos de
Activity/engine. `engineCreated` **não comprova** inicialização ou reprodução:
é necessário observar o callback e reproduzir um canal a seguir.

Cada attachment aceita um único submit, evitando atribuir uma resposta tardia a
um segundo login. Timeout não cancela a requisição do APK; o resultado permanece
desconhecido e a autenticação original pode terminar depois de sair da ferramenta.

O RPC `setuptv()` conclui somente a escolha inicial do tipo de dispositivo. Ele
exige `SP_DEVICE_TYPE == -1`, fragment de login ausente e exatamente um diálogo
original da Activity com os três IDs de recursos comprovados. Executa o setter
original com `0` (TV), fecha esse diálogo e chama a inicialização original
`Spark.v()`, na mesma ordem do listener original. Recusa configurações existentes
e diálogos ausentes/ambíguos. Foi executado no AVD de teste, retornando
`configured: true` e `loginFragmentReady: true`; isso não comprova autenticação.

## Evidência estática

- `be.e.onClick`, `classes2.dex`, 0x140578–0x1405a6: `i0.t(1,g.b)`,
  `i0.u(g.e,username)`, `i0.u(g.f,password)`, `Spark.g3.sendEmptyMessage(13)`.
- `e1.handleMessage`, switch em 0x19b34c: mensagem 13 → pc 0x93c
  (0x19c510), `EVENT_SUBMIT_USERNAME_PASSWORD`, e chamada
  `Spark.D0.getUser().j()` em 0x19c536.
- `td.m.j`, trampoline 0x114b38, VM em 0xa466e, 298 words: modo 1 com
  username não vazio zera o contador de tentativa e chama `td.m.e()`
  (VM 0xa46e6–0xa46ea).
- `td.m.e()` é o builder HTTP original documentado em
  `analysis/WPLAYP2P-11.9.0d-auth-contract.md`.
- `Spark.onCreate` lê `SP_DEVICE_TYPE` com padrão `-1` em
  0x186382–0x18639c; só chama `v()` direto quando já configurado. O primeiro
  acesso abre o diálogo identificado pelos IDs `0x7f0b02cc`, `0x7f0b02cb`,
  `0x7f0b00a2`. `ae.p1.onClick`, 0x13a17e–0x13a19a, executa
  `setDeviceType` → `Dialog.dismiss` → `Spark.v`.
- `SparkViewModel.setDeviceType`, VM 0xbccea–0xbcd16, atualiza o estado e
  persiste a preferência. `ue.r.e()`, VM 0x9f5ba–0x9f5f8, retorna
  `isPhone == true` apenas para tipo `1`; o outro valor do listener é `0`.
- Frida usa o alias `_d` para o campo `td.m.d`, pois a classe também tem um
  método `d(String)`. O helper `javaField` reconhece essa colisão. O mesmo
  ocorre com o campo `Spark.U` e o método `U()`.

Esses caminhos foram recuperados estaticamente. Os testes de
`login.test.mjs` usam classes substitutas locais, sem autenticação externa.

## Verificação no emulador

No AVD isolado de teste, depois da configuração inicial como TV e do reinício
normal do APK, o submit original autenticou a conta: a tela inicial foi exibida,
`AuthInfo.code` era `0`, usuário e serviço estavam presentes e a conta em memória
correspondia à preferência salva. A ferramenta havia retornado timeout: era um
falso negativo do observador, não uma rejeição do serviço. A causa exata de o
hook Java não concluir ainda não foi isolada.

A observação de mudança de estado acima corrige esse caso e tem cobertura local,
incluindo rejeição de estado antigo, privacidade e limpeza dos temporizadores.
Não foi feito outro login real só para repetir o teste, preservando a sessão
autenticada usada na verificação de reprodução. Os testes do transporte também
verificam que a entrada de credenciais em um terminal não é ecoada.
