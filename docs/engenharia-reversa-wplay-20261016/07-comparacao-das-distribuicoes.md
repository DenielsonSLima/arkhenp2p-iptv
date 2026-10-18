# Comparação das duas distribuições

Fonte: leitura de todos os membros ZIP, manifests REA atuais e declarações DEX. Identidades completas em [01](01-identidade-metodo-e-cobertura.md).

Os arquivos não são o mesmo aplicativo com outro nome de arquivo: 11.9.0d e 12.0.3 têm DEX, manifesto, recursos e algumas bibliotecas diferentes. Ambos declaram o mesmo package ID; isso não autoriza instalar uma versão sobre a outra nem comprova assinatura compatível.

| Resultado da comparação pelo mesmo caminho ZIP | Quantidade |
| --- | ---: |
| Membros comuns com bytes idênticos | 1.939 |
| Membros comuns com bytes diferentes | 521 |
| Somente no primário | 3 |
| Somente no BinStream | 9 |

A lista completa, com SHA de cada membro, está em [inventario-artefatos.json](inventario-artefatos.json). XML binário e recursos podem mudar por reindexação; bytes diferentes não demonstram uma alteração visual ou funcional específica.

## Código e transporte

Ambos os DEX mudaram. O segundo APK tem mais 13 definições de classe, mais 69 métodos definidos e mais 32 métodos declarados nativos no total. Uma diferença numérica não identifica qual algoritmo mudou.

Seis bibliotecas nativas comuns mudaram: `libtvcore.so`, `libijkplayer.so` e `libijkcodec.so`, cada uma nas duas ABIs. As outras 16 bibliotecas, incluindo `libgojni.so`/BinStream nas duas ABIs, têm bytes idênticos entre esses dois arquivos. A presença de BinStream já no primário impede concluir pelo nome do segundo arquivo que só ele inclui esse transporte.

Os inventários [classes-primary.tsv](classes-primary.tsv), [classes-binstream.tsv](classes-binstream.tsv), [metodos-primary.tsv](metodos-primary.tsv) e [metodos-binstream.tsv](metodos-binstream.tsv) permitem resolver nomes e offsets por versão. Índices de string, nomes ofuscados e endereços não devem ser transplantados entre DEX diferentes.

## O que pode ser reutilizado como evidência

| Caso | Regra |
| --- | --- |
| Mesmo membro e mesmo SHA-256 | A evidência dos bytes desse membro pode ser compartilhada; contexto de chamada continua pertencendo ao APK correspondente. |
| Mesmo nome de classe, DEX diferente | Inspecionar a declaração/método do alvo antes de atribuir comportamento. |
| Mesmo método decompilado em relatórios antigos | Fonte histórica até validar os bytes ou reinspecionar o método atual. |
| Mesma biblioteca com hash diferente | Não reutilizar offsets, tabelas JNI, strings ou análise de controle automaticamente. |
| Endpoint que aparece em uma configuração | Não prova host ativo, contrato atual ou disponibilidade de uma conta. |

O estudo de armazenamento/EPG aprofunda a versão primária. Equivalência integral das políticas na 12.0.3 não foi demonstrada por um diff binário. Nenhuma das versões foi executada.
