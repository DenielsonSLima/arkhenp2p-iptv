# Identidade, método e cobertura

Leitura local em 16/10/2026; envelopes REA gerados em 17/10 UTC. Dois APKs fornecidos no workspace foram identificados separadamente. Nenhum aplicativo Android foi instalado ou executado, nenhum serviço do provedor foi chamado e nenhuma conta foi utilizada.

## Artefatos exatos

| Propriedade | `WPLAYP2P.apk` | `WPlay P2P BinStream.apk` |
| --- | --- | --- |
| Rótulo dos inventários | `primary` | `binstream` |
| SHA-256 | `2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69` | `9752e3f6ffdc522bc3e6a1e8e3e7989737bf09db44c0b220e9eb8c637aeb9e9e` |
| Bytes APK | 27.091.019 | 27.091.358 |
| Pacote | `io.wareztv.android.one` | `io.wareztv.android.one` |
| Versão / código | 11.9.0d / 1190 | 12.0.3 / 1203 |
| SDK mínimo / alvo declarados | 21 / 35 | 21 / 35 |
| Entradas ZIP | 2.463 | 2.469 |
| DEX | 2 | 2 |
| Definições de classe DEX, incluindo internas | 10.277 | 10.290 |
| Métodos definidos DEX | 66.249 | 66.318 |
| Métodos declarados `native` | 2.735 | 2.767 |
| Classes no namespace `org.bitspark` | 501 | 500 |
| Métodos desse namespace / nativos | 3.673 / 1.919 | 3.679 / 1.926 |
| Bibliotecas `.so` / ABIs | 22 / ARM64 e ARMv7 | 22 / ARM64 e ARMv7 |

A contagem REA/JADX foi 7.977 e 7.992 classes na visão fornecida pelo produtor. Os números maiores da tabela vêm de todos os registros `class_defs` dos dois DEX, incluindo classes internas. Não se trata da descoberta de milhares de classes novas entre versões. Identidade de pacote também não demonstra identidade de código ou validade da assinatura.

## Métodos utilizados

1. SHA-256 do APK e de cada membro descompactado, sem executar conteúdo.
2. REA 6.4.0 `inspect-android-package`, `inspect-android-class` e `inspect-android-method`, com o JAR JADX 0.7.1 já disponível. Envelopes canônicos completos ficam em área privada de análise; esta pasta publica referências e conclusões sanitizadas.
3. Parser direto de cabeçalhos, tabelas DEX e `class_data`, disponível em [ferramentas/inventariar_dex.py](ferramentas/inventariar_dex.py). Enumera todas as declarações, flags e offsets; não interpreta instruções nem carrega classes do alvo na JVM.
4. Leitura focada de instruções/strings e ELF para ligar caminhos específicos de catálogo, armazenamento, EPG e reprodução. Os documentos temáticos identificam quando a fonte é DEX, REA, ELF ou relatório histórico.

O MCP conectado não tinha `REA_JADX_MCP_JAR` configurado. Foi usado o launcher público existente da CLI, com JAR, Java 21, um worker e heap 768 MiB selecionados somente para o processo. Nenhuma configuração global foi alterada. Uma tentativa de inventário genérico pela API `JavaClass.getInnerClasses()` iniciou expansão de código e falhou; ela foi descartada, e os inventários finais vieram exclusivamente das tabelas DEX. Não se usa sua saída parcial como prova.

JAR: SHA-256 `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`, revisão upstream registrada pelo REA `5844800a486d2248fa949b74c9896285f5b54de2`. O nome do núcleo JADX reportado como `dev` não substitui essa identidade verificável.

## Evidências de identidade

| ID REA atual | Objeto |
| --- | --- |
| `ev_10e6cd4c74d55d8153c1a476e0a2873b3ca563cd42dfd1f8cf23bc4d3dbad0eb` | Pacote, versão e manifesto do APK primário |
| `ev_2e9fcb292182d4045d402fbcff4af04f513cf67a70f4884c802afe8033cd6d33` | Pacote, versão e manifesto do BinStream |

[identidade-e-componentes.json](identidade-e-componentes.json) conserva resumos e componentes. [manifest-primary.xml](manifest-primary.xml) e [manifest-binstream.xml](manifest-binstream.xml) foram obtidos dos envelopes atuais; valores de metadados sensíveis, caso presentes, são ocultados pelo exportador. Nenhuma assinatura criptográfica APK foi validada nesta análise.

## Proveniência e endereços

O diretório histórico `analysis/` contém extrações de 12.0.3 e relatórios sobre 11.9.0d. Um nome de arquivo antigo não demonstra seu vínculo ao APK primário. Por exemplo, `analysis/native/libtvcore.so` e `libijkplayer.so` diferem dos membros primários atuais; `libgojni.so` pode coincidir. Cada reutilização precisa conferir o hash do membro.

Nos TSV, `code_item_offset` é um offset de arquivo no DEX indicado; `instructions_offset` é o início do array de instruções. Métodos nativos/abstratos podem ter `code_item_offset=0x0`: isso não é endereço de implementação JNI. Endereços virtuais ELF e offsets de arquivo nativo são espaços diferentes. Nomes de apresentação/overload do JADX valem para o artefato e produtor indicados.

## Busca delimitada de dependência Supabase

Os dois DEX de cada APK foram percorridos pelas tabelas de strings; os bytes das 22 bibliotecas `.so` de cada APK também foram examinados. Houve zero correspondências literais, sem diferenciar maiúsculas, para `supabase`, `postgrest`, `supabase.co`, `/rest/v1/` e `realtime/v1`. Contagens estão em [resumo-dex-primary.json](resumo-dex-primary.json) e [resumo-dex-binstream.json](resumo-dex-binstream.json).

**Conclusão permitida:** não foi identificada dependência direta desses nomes/rotas nessa busca. **Limite:** strings cifradas, carregamento dinâmico, chamadas JNI e a implementação dos servidores não são cobertos por uma busca literal. Uma API consumida pelo APK poderia usar qualquer banco internamente. Portanto, não foi provado que o backend do fornecedor não usa Supabase.

## O que significa cobertura completa aqui

O inventário de membros ZIP e de declarações DEX cobre os dois arquivos inteiros. A reconstrução de comportamento aprofunda catálogo, EPG, armazenamento e reprodução do primário, com comparação explícita da segunda distribuição. Não equivale a recuperar o código fonte de todos os métodos: mais da metade dos métodos no namespace do produto são declarados nativos, além de ofuscação e bibliotecas fechadas. Cada pergunta sem resposta permanece listada, sem transformar falta de leitura em ausência de função.

Não foram observados RAM ocupada, tráfego real, tempo de abertura, decodificação, timers efetivamente recebidos por uma conta, comportamento após reboot ou disponibilidade de mídia. As declarações estáticas do manifesto não comprovam execução de serviços.
