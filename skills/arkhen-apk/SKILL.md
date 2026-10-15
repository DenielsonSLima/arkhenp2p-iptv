---
name: arkhen-apk
description: Analisar estaticamente o APK WPLAY e comparar seus contratos com o player web para o ARKHEN.
---

Leia `docs/wplay-playback-contract.md`. Identifique o APK por hash e versão antes de reutilizar achados de outro binário. O arquivo original deste projeto é ignorado pelo Git.

Inspecione ZIP, manifesto, DEX, assets e ABIs sem executar o aplicativo como passo padrão. Diferencie código presente, strings sem referência e comportamento realmente observado. TVCore/BinStream Android não são automaticamente um SDK JavaScript.

Compare autenticação/catálogo/reprodução com os bundles públicos do player web autorizado. Ausência de WASM num chunk não prova ausência em todos os chunks; um WebView de legendas não demonstra player web embutido.

Não alterar autenticação, certificados, retorno de autorização ou DRM. Não extrair/registrar credenciais. Instalar ferramentas, abrir APK ou mudar o sistema não decorre automaticamente de uma solicitação de análise estática.

Referência: [apkanalyzer oficial](https://developer.android.com/tools/apkanalyzer).
