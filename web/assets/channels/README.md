# Logos reais dos canais WPLAY

Gerado em 2026-10-14T00:55:05.972Z a partir do catálogo ao vivo autorizado (wplay-p2p-apk-11.9.0d). O manifesto cruza IDs desta origem e nomes exatos, incluindo variantes de qualidade, sem associação aproximada entre canais ou afiliadas. IDs do APK e do portal OTT usam espaços diferentes; a associação entre essas origens exige nome exato e inequívoco.

- Canais no catálogo: 760
- Canais com logo local: 746
- Fontes de imagem distintas: 217
- Downloads concluídos: 204
- Arquivos WebP únicos: 202
- Fontes deduplicadas por bytes WebP idênticos: 2
- Bytes originais baixados: 3581834
- Bytes WebP únicos: 1428898
- Canais sem logo local: 14

As imagens mantêm transparência e proporção, sem fundo adicional. O maior lado tem no máximo 256 pixels, sem ampliar logos menores. WebP usa quality 84 e method 6. Imagens animadas usam o primeiro frame.

O campo opcional `artwork` do manifesto registra dimensões e limites dos pixels visíveis. O frontend usa essas medidas para enquadrar o logo em uma caixa escura, sem alterar ou duplicar o WebP. A sincronização gera essas medidas automaticamente; `python3 tools/measure-channel-logos.py` também pode atualizar o manifesto usando os arquivos já baixados, sem rede.

Os downloads são agrupados pela fonte exata e limitados a quatro conexões simultâneas, 15 segundos e 5 MB por imagem. Arquivos sem fonte ou com falha estão em failures.json; nenhum logo alternativo foi inventado.

Reexecutar na raiz do projeto:

```sh
node tools/sync-channel-logos.mjs --apk-native
```

Informar uma única linha JSON via stdin com os campos username e password. O terminal desativa o eco durante a leitura. O script não grava credenciais, cookies, tokens ou URLs de origem no manifesto, nos assets ou no relatório. Os downloads temporários da própria execução são removidos ao finalizar. Não são baixados vídeos, filmes ou cartazes.

O modo --apk-native usa somente o servidor de autenticação alternativo autorizado do APK, uma vez, sem tentativa automática em outro servidor. A consulta de catálogo e logos não instala nem executa a engine P2P e não implica compatibilidade de reprodução no navegador. Nenhum logout remoto é executado.
