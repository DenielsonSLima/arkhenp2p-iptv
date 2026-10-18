---
name: arkhen-p2p
description: Investigar protocolos e alternativas de reprodução P2P/TVBus no ARKHEN sem pressupor emulação Android local.
---

Leia `docs/wplay/README.md`, `docs/wplay/reproducao.md` e o registro histórico em `docs/wplay-playback-contract.md`.

Identifique o protocolo real da fonte autorizada. Priorize HTTP fornecido pelo catálogo e o fluxo web WPLAY confirmado pelo usuário. `tvbus://`, `tvcars://` e HTTP são contratos diferentes: não invente uma URL HTTP a partir de um identificador P2P.

A existência de um APK Android não demonstra que o frontend web precise de emulador. O usuário determinou a exclusão da ponte experimental em 16/10/2026: módulos, instaladores e runtimes locais foram removidos. Não recrie nem ative Android, ADB, Frida ou um motor local para reprodução. O APK é evidência estática; o caminho operacional usa os serviços e o transporte HTTP/HLS autorizado do player web WPLAY.

Uma fonte ativa pertence à sessão e à seleção atual. Cancelamento, troca de canal, logout e retorno atrasado não podem reviver uma reprodução antiga. Preserve a semântica de stop/sid/generation do provedor. Headers de credenciais só acompanham a origem autorizada correspondente.
