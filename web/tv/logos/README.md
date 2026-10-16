# Logos de TV

Imagens originais WebP do catálogo WPLAYP2P 11.9.0d, sem download, edição ou reprodução nesta reorganização.

O manifesto associa IDs nativos e nomes exatos. A categoria vem somente de um snapshot sanitizado publicado; não é inferida do nome do canal, da marca ou das categorias de outro servidor. A lista de categorias é um dado recebido em execução pelo APK, não uma lista fixa embutida nele.

- Logos distintos: 202
- IDs com logo: 746
- IDs com categoria verificada: 0
- Categorias verificadas: 0
- Logos sem categoria verificada: 202

Cada WebP tem um arquivo canônico na categoria com maior número de canais associados (desempate por ID). Os arquivos index.json das demais categorias apontam para esse mesmo arquivo. Hash SHA-256 integral e geometria visual estão no manifesto.

Os arquivos antigos em /assets/channels/ permanecem durante a migração de URLs de favoritos e cache. legacyAliases permite ao servidor resolver esses endereços sem mudar a identidade dos canais. Essa cópia temporária é de compatibilidade, não de categorias.

Regenerar, sem rede ou credenciais:

```sh
node tools/organize-tv-logos.mjs --catalog web/tv/logos/catalogo-categorias.json
```

O catálogo de entrada contém somente schemaVersion, idNamespace, observedAt, categories (id/name) e items (id/name/categoryIds/categoryId opcional). Sem snapshot verificado, omitir --catalog conserva todos em sem-categoria-verificada; isso explicita a falta de evidência. O manifesto anterior não é descartado por uma categoria ausente.
