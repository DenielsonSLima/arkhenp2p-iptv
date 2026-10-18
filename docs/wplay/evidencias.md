# Evidências WPLAY

Data da leitura: 16/10/2026; conferência final de arquivos às 22:18 UTC. Evidências estáticas, sem executar o JavaScript distribuído, autenticação ou mídia.

## Assets públicos atuais

O HTML de `https://player.wplayott.com/auth` referenciou o entrypoint abaixo. Esse entrypoint referencia o watch atual. A consulta do caminho histórico `watch-C_eKJ0Kf.js` retornou 404; o contrato antigo não foi usado como prova da versão atualmente publicada.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| HTML `/auth` | 7357 | `250d63734863f871e96c573bc3742a0a5a6db77a26fcd1d1ae68725d3e72022f` |
| `index-DVOFCX81.js` | 546195 | `300404ba356c356b4991b15c47513db49e97c40512b3dfd72e0c8aeb5a8b2200` |
| `auth-C3TbW9Ji.js` | 23018 | `45a110ad786281d101599b5f27db09d25181b6402eab7382aea8f05b2aeba712` |
| `createClientRpc-hwXvz0RK.js` | 33668 | `03ba3467a9206bfc385f7bf52e4049b163d169f177c2e2513fb26a27f97d39fa` |
| `wplay.functions-sItkKweF.js` | 1853 | `86d99573f8545d267c86647b5746875808cec96c82df85f6221cd9ddd1470df3` |
| `watch-D81zhcTq.js` | 91180 | `9834816cc51b361721ad7435885aace8c6153ea7d70e6e735701cf03f6d0673e` |
| `hls-BhcDaTqf.js` | 574790 | `5b33b12b2af3235f18d377a5b3d673d6baeb95b85a02a2c8d5cb3514c1bcf2ff` |
| `auth-middleware-CsXiNBLf.js` | 77 | `14bfe9e425e058a2e6e9cb963c8f81253758eb0f6bd831361e05a2cfd5936243` |

Os caminhos completos de JS são relativos a `https://player.wplayott.com/assets/`. Nenhum endpoint de autenticação ou mídia foi chamado nesta coleta; somente HTML e arquivos JavaScript públicos.

## REA atual

- Análise da árvore de seis arquivos HTML/JS: `ev_a83433d60eb8417fb6fc73d53e82fe6e2330752661c9ad4fd32e5121c38729cd`.
- Resumo retido: `ev_ab75e4f89fa105b27b29aff2724a27e4b8bb8df014b494d14c75f320154161e6`.
- Identidade exata do asset watch: `ev_cd6408bc13de5eb61d47de91c33a44cf931db3b422f698fa2773d3d06e04e5e1`.
- Módulo ESM watch, export `component`, intervalo de origem linha1/colunas0–91070: `ev_5cff82623705766a57d5ef5d211228ca75815e6b987bfd3a562827beda868dc2`.
- Importação dinâmica do HLS, observada estaticamente e inicialmente não resolvida dentro da árvore: `ev_8b165cfde15dc904f18a1d5b1445340426703cea3d7000e075f922b8aea0b934`. O asset HLS foi obtido separadamente depois, com o hash acima; não foi apresentado como já incluído naquela análise REA.

Cobertura: cinco arquivos JS parseados, sem erro sintático, mais HTML. O worker esgotou o limite de heap durante a semântica do grande entrypoint; parte da expansão semântica do watch excedeu o orçamento restante. Fatos de módulo e AST foram retidos, mas o grafo é parcial e relações dinâmicas permanecem desconhecidas. A inspeção textual focada dos bytes complementa o REA; não transforma ausência em prova global.

O bundle completo de evidências da sessão foi exportado para arquivo temporário fora do repositório. O corpus versionado mantém somente estes IDs, hashes, localizações e conclusões sanitizadas, sem copiar bundles distribuídos ou configurações públicas de serviços.

## Localizações do código público

Offsets são bytes UTF-8, base zero, no asset original indicado. Os assets minificados têm uma linha principal; nomes minificados valem somente para esses hashes. A leitura formatada foi produzida pelo parser local, sem executar o alvo.

| Asset / âncora | Offset | Fato delimitado |
| --- | ---: | --- |
| watch / `Ye` | 7386 | POST STOP, `sid/gen`, 204, prazo 12 s |
| watch / `Xe` | 7632 | Perfil live de buffer/latência |
| watch / `tt` | 8117 | Retry-After, mínimo 30 s, recuperação até 35 s |
| watch / `nt` | 8305 | Loader live, recuperação429 única e cancelamento |
| watch / `rt` | 10073 | HLS nativo Safari/iOS |
| watch / `ot` | 10567 | Componente comum TV/VOD |
| watch / import HLS | 13592 | Importação de `hls-BhcDaTqf.js` |
| watch / nível inicial | 15062 | Escolha do nível live próximo de 720 linhas |
| watch / ramo TV/VOD | 16319 | TV escolhe nativo/HLS; VOD tenta nativo primeiro |
| watch / intervalo | 47220 | Constante de 3 s entre gerações |
| watch / `Xn` | 54760 | Tela live, variante HD e sessão persistida por aba |
| watch / fila | 56839 | STOP anterior, revalidação da seleção, intervalo e nova geração |
| auth / instalação Auth | 15242 | Tokens retornados ao SDK após resposta autenticada |
| RPC / identificação | 31286 | Header `x-tsr-serverFn` |
| RPC / resposta | 32387 | `x-tss-serialized` e framing |
| RPC / endpoint | 33456 | Construção de `/_serverFn/<id>` |
| HLS / versão | 170168 | Constante de versão 1.7.3 |

## APK existente e evidência histórica

O hash de `WPLAYP2P.apk` na raiz foi reconferido em 16/10/2026: `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69`. Identifica o mesmo pacote `io.wareztv.android.one`, versão 11.9.0d/1190, das inspeções anteriores; reconferir hash não é nova execução/decompilação nem verificação de assinatura.

| Evidence ID histórico | Cobertura registrada |
| --- | --- |
| `ev_7165955158c69adafa7a27e1fbcb99199bc9192c84fbf3cdac36d9f1d86fed5d` | Inventário APK, dois DEX, bibliotecas Android, sem membros JS/HTML/WASM |
| `ev_b8d03dbae27b78f6eec1f14809debe894ee76ff4f2aa3499b49ee0fff4340c3f` | Inspeção Android do pacote, 7.977 classes, 2.463 recursos |
| `ev_cffac46faeb24c4ed30704f057a35f3209998fbbdefd17350ee6d2307b3ca3cc` | `ChannelBean`: fontes, seleção e EPG |
| `ev_a46eb48d11eea39be2205f33e8044657a720794007cec186348a72784f843dcd` | `SourcesBean`: endereço/backup/qualidade/subtítulo |
| `ev_aa933a3331d7b27993008211a507bd69ac3be0876a945289e99b425b56eefc20` | Interface JNI TVCore; não prova implementação web |

Fontes preservadas: [inspeção de TV/APK](../tv-backend-modules-20261016.md), [contrato de autenticação](../../analysis/WPLAYP2P-11.9.0d-auth-contract.md) e [contrato histórico de reprodução](../wplay-playback-contract.md). Os IDs históricos não foram recuperados do ledger da sessão REA atual; sua proveniência é o relatório anterior ligado ao mesmo SHA. A revisão não repetiu os resultados como observação remota nova.

## Questões ainda abertas

Não houve execução para comprovar login atual, catálogo de uma conta, correspondência de um canal específico, resposta STOP, acesso à CDN, decoder, faixa de áudio/legenda, reprodução ou latência. Não se conhece o interior do servidor oficial a partir destes bundles. Nenhuma dessas lacunas autoriza fabricar HTTP a partir de URI P2P ou iniciar um runtime local experimental.
