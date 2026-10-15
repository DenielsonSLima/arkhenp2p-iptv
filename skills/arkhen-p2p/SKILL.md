---
name: arkhen-p2p
description: Investigar protocolos e alternativas de reprodução P2P/TVBus no ARKHEN sem pressupor emulação Android local.
---

Leia `docs/wplay-playback-contract.md` e as decisões atuais em `docs/engineering-recovery.md`.

Identifique o protocolo real da fonte autorizada. Priorize HTTP fornecido pelo catálogo e o fluxo web WPLAY confirmado pelo usuário. `tvbus://`, `tvcars://` e HTTP são contratos diferentes: não invente uma URL HTTP a partir de um identificador P2P.

A existência de um APK Android não demonstra que o frontend web precise de emulador. Analise o player oficial antes de propor runtimes. O experimento Android deste projeto é opcional e foi interrompido por orientação do usuário; não o reinstale ou ative como fluxo padrão.

Uma fonte ativa pertence à sessão e à seleção atual. Cancelamento, troca de canal, logout e retorno atrasado não podem reviver uma reprodução antiga. Preserve a semântica de stop/sid/generation do provedor. Headers de credenciais só acompanham a origem autorizada correspondente.
