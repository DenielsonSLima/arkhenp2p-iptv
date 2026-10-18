# ARKHEN — arquivos da marca

As versões para a interface são vetores transparentes, reconstruídos a partir de
`Camada 2.png` (símbolo) e `fff.png` (nome) fornecidos pelo usuário. O desenho mantém
as quatro lâminas, a abertura central, as facetas prateadas, o A sem travessão e a
grafia **ARKHEN** que aparece na imagem de referência. O acabamento usa degradês
vetoriais de prata e bordas finas.

Use `symbol.svg` e `wordmark.svg` na interface. As curvas escalam sem perder
definição; ambos têm o fundo vazio e a área de desenho recortada ao redor da marca.
`symbol.png` (1024 × 1107) e `wordmark.png` (2388 × 256) são alternativas com canal
alpha, renderizadas diretamente da geometria vetorial.

`favicon.svg` usa o símbolo. Há PNGs de 16, 32, 48, 192 e 512 pixels e
`apple-touch-icon.png` de 180 pixels. `favicon.ico` contém 16, 24, 32, 48, 64, 128 e
256 pixels. Todos preservam transparência.

O documento declara ICO, PNGs com tamanhos explícitos, SVG e Apple Touch Icon.
`web/favicon.ico` e `web/apple-touch-icon.png` são cópias dos arquivos da marca,
mantidas pelo gerador para descoberta nos endereços padrão da raiz.
`safari-pinned-tab.svg` usa a mesma geometria em uma única silhueta preta com
`viewBox="0 0 16 16"`, conforme o [contrato da Apple para abas fixadas](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/pinnedTabs/pinnedTabs.html).
Os links de ícone usam uma revisão de URL para renovar o cache após alterações.

O gerador está em `tools/build-brand-assets.py`, na raiz do projeto, e pode ser
executado com Python, Pillow e NumPy. Ele também atualiza `inventory.json`. Os
arquivos originais na pasta `Logo` do iCloud permanecem preservados.

As duas referências pequenas tinham fundo preto **opaco**, embora o formato fosse
RGBA. O símbolo tinha somente 115 × 120 pixels. A recriação vetorial resolve a
transparência e a nitidez sem ampliar esses pixels. Trata-se de uma reconstrução
geométrica da referência, sem arquivo-mestre vetorial oficial e sem edição por
geração de imagem. O PSD e as variações V encontradas na pasta foram usados apenas
como contexto visual, porque apresentam composições distintas da marca isolada
solicitada.

`provenance.json` registra o tamanho, o canal alpha e o hash SHA-256 das referências.
O fundo atual do login é `login-collage.jpg`, convertido para JPEG nas dimensões
originais 1672 × 941 a partir do mosaico fornecido pelo usuário. A cópia exata do
PNG fica em `login-collage.png`; hashes e detalhes estão em
`login-collage-provenance.json`. O arquivo de origem permanece preservado e o
degradê é aplicado somente por CSS. `login-cinema.jpg` permanece como arte anterior,
separada dos arquivos do logotipo.

## Fundo do login

`login-cinema.jpg` foi gerado com a ferramenta integrada ImageGen e convertido
para JPEG para uso local. Prompt final:

> Fotografia cinematográfica ampla de uma sala de cinema vazia vista ao fundo,
> poltronas de veludo vinho, tela escura monumental, luzes âmbar discretas e um
> feixe suave de projetor com névoa leve. Sombras profundas e espaço escuro para
> sobrepor o formulário. Sem pessoas, textos, logotipos, marca d’água ou interface.

O degradê de opacidade pertence ao CSS da tela e pode ser ajustado sem alterar
a imagem. A transparência dos logotipos é independente desse fundo.
