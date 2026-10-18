# Catálogo, capas e fontes

Revisão estática: 16/10/2026. Os fatos web abaixo se referem ao bundle identificado em [Evidências](evidencias.md).

## Catálogo do site

**Observado:** a tela oficial confirma a sessão antes de chamar a função de catálogo. Ela consome `rows` com `items` e uma lista `heroes`; usa tipos de apresentação Canal, Filme e Série. Uma resposta com erro e um catálogo sem itens têm estados próprios na interface.

Um canal pode oferecer `liveVariants` com qualidade e `playbackUrl`. A tela usa o endereço retornado da variante escolhida. Seu padrão inicial é HD; se a variante não existir, usa a primeira oferecida. O vocabulário de qualidade observado é SD, HD, FHD e 4K. Isso é qualidade declarada, não medição dos quadros recebidos.

**Observado:** séries possuem episódios com temporada, identidade e endereço de reprodução próprios. Detalhes/capas e episódios usam funções distintas do catálogo no módulo público. A tela carrega esses complementos sob demanda. Uma imagem de capa não exige iniciar ou capturar o vídeo.

**Correspondência ARKHEN:** `lib/wplay/ott/provedor.mjs` normaliza `rows[].items[]`, variantes e episódios, mantém `rawItems` privados e registra imagens no proxy autenticado. Os IDs públicos numéricos que o adaptador OTT produz são uma decisão ARKHEN; não são o algoritmo de identidade demonstrado pelo site ou pelo APK.

## Catálogo do APK

**Evidência estática recuperada do mesmo artefato:** `ChannelBean` declara fontes, identificador selecionado e dados EPG; `SourcesBean` declara endereço, backup, texto da fonte, bitrate e atributos de qualidade. `EpgBean` contém nome, início, término e endereço de replay. Existência de um campo não comprova que uma conta atual o receba nem sua unidade ou validade.

O catálogo nativo conserva seus IDs recebidos. Os endpoints são fornecidos por `AuthInfo.service`; o fluxo histórico de detalhes VOD usa o identificador do título no endpoint de busca autorizado. `lib/wplay/vod/catalogo-nativo.mjs` é o núcleo comum dos metadados de Filmes/Séries, mantendo as gerações independentes.

## Preservação da biblioteca

O catálogo nativo e o catálogo OTT não possuem equivalência matemática de IDs comprovada. Trocar o provedor principal ou substituir um ID nativo pelo hash OTT pode romper favoritos, histórico e escopo de conta.

`lib/wplay/ao-vivo/resolver-web.mjs` associa o canal nativo à oferta web somente quando existe identidade explícita comum ou correspondência única e conservadora do nome completo. Região, afiliada, número e demais qualificadores continuam significativos. Ambiguidade deve falhar de forma explícita; não se trata outro canal como variante de resolução.

URLs de reprodução, cookies e tokens permanecem na sessão privada. Supabase guarda metadados seguros e biblioteca por proprietário; não recebe a fonte privada como se fosse capa ou dado global.

## Cálculos e apresentação no ARKHEN

O site oficial contém filtros e cálculos de interface no navegador. Essa observação não altera a exigência do usuário para o ARKHEN: seleção de quatro canais, audiência, ordem, busca e recomendações pertencem às RPCs do projeto. O frontend apresenta a projeção recebida. Decodificação, seleção de uma faixa realmente exposta e leitura de dimensões do vídeo continuam sendo capacidades locais do navegador.

**Lacunas:** não foi consultado catálogo autenticado nesta revisão. Contagens, categorias disponíveis, capas válidas e equivalência de um canal específico exigem evidência atual separada. A autorização do catálogo não prova que a fonte correspondente esteja operacional.
