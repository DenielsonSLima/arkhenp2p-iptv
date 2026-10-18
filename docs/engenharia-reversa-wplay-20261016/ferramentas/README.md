# Reprodução da análise estática

Executar os parsers lê os arquivos fornecidos; não executa o APK, seu JavaScript, suas bibliotecas nativas ou seus serviços. Os APKs originais permanecem intactos.

## Inventários DEX

Da raiz do repositório:

```sh
python3 docs/engenharia-reversa-wplay-20261016/ferramentas/inventariar_dex.py \
  WPLAYP2P.apk docs/engenharia-reversa-wplay-20261016 primary
python3 docs/engenharia-reversa-wplay-20261016/ferramentas/inventariar_dex.py \
  'WPlay P2P BinStream.apk' docs/engenharia-reversa-wplay-20261016 binstream
```

Biblioteca padrão Python, sem download. Os arquivos `classes-*`, `metodos-*`, `campos-*` e `resumo-dex-*` são regenerados. Flags são valores DEX; `0x100` significa a declaração nativa. `code_item_offset=0` não localiza implementação JNI. Contadores de métodos definidos são distintos de `method_ids`, que também inclui referências externas.

O parser admite o DEX padrão presente nesses APKs. Não é um decompilador nem uma ferramenta geral de validação de arquivos maliciosos. Modificações futuras do formato exigem revisão; contagens/offsets publicados são vinculados aos SHA desta análise.

Os inventários focados dos cinco ELF ARM64 e os valores constantes da classe Media3 podem ser regenerados sem carregar bibliotecas do alvo:

```sh
python3 docs/engenharia-reversa-wplay-20261016/ferramentas/inventariar_elf.py \
  WPLAYP2P.apk --output-dir docs/engenharia-reversa-wplay-20261016
python3 docs/engenharia-reversa-wplay-20261016/ferramentas/ler_defaults_buffer.py \
  WPLAYP2P.apk docs/engenharia-reversa-wplay-20261016/buffers-media3-primary.json
```

Valores de buffer recuperados são defaults da classe distribuída, não uma medição de memória nem os parâmetros efetivamente escolhidos pelo aplicativo.

## REA e decompilação focada

Foi usado o launcher público da instalação existente do REA 6.4.0, no cache npm local. Para cada processo, foram fornecidos:

```sh
REA_JADX_MCP_JAR="$PWD/.local/tools/jadx-headless-mcp-0.7.1-all.jar" \
JAVA_HOME='<JDK 21 existente>' \
REA_JADX_HEAP_MIB=768 \
rea inspect-android-class "$PWD/WPLAYP2P.apk" org.bitspark.android.Spark \
  --format json > '<diretório privado>/Spark.json'
```

Quando `rea` não estiver no PATH, usar o launcher público existente confirmado pela instalação, não um arquivo interno `dist/cli.js`. `inspect-android-package` identifica o pacote; `inspect-android-method` recebe classe, método e índice de overload retirado do inventário. Nenhuma configuração global, SDK Android ou emulador foi instalado.

Os resultados canônicos completos foram preservados em `.local/analysiscurrent/apk-dissection-20261016/`. Essa área ignorada pode conter constantes do APK; não deve ser incorporada à memória ou publicada em massa. Os documentos citam Evidence IDs, símbolos, hashes e conclusões sem copiar credenciais ou fontes privadas.

`python3 docs/engenharia-reversa-wplay-20261016/ferramentas/indexar_evidencias.py` regenera somente o índice público de proveniência dos envelopes privados disponíveis. Não exporta seus corpos.

Algumas respostas de método do produtor usam mensagens genéricas como “native/abstract”. A classificação deve ser conferida com flags e `code_item` DEX: nessa investigação um inicializador com corpo DEX foi recuperado por leitura direta apesar daquela mensagem. Resultados incompletos não são usados como prova de ausência de código.

## Integridade e limites

`inventario-artefatos.json` contém os SHA do APK e de todos os membros ZIP descompactados. A comparação usa bytes do mesmo caminho; não constitui diff semântico de XML/DEX nem valida assinatura APK.

A evidência DEX/ELF complementar é identificada como parser local, sem inventar Evidence ID REA. Arquivos de código decompilado e strings permanecem privados. Nenhum endpoint descoberto foi chamado para validar disponibilidade, conta ou mídia.
