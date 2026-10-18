# Evidências e questões remanescentes

Este quadro fecha a investigação pelo que seus arquivos demonstram. Inventariar uma declaração, recuperar código estático e observar execução são níveis diferentes. Não houve execução do APK.

| Pergunta | Cobertura | Fonte principal | Limite restante |
| --- | --- | --- | --- |
| Quais são os arquivos/versionamentos? | Respondida para ambos | [01](01-identidade-metodo-e-cobertura.md), ZIP, manifests e REA de pacote | Assinatura criptográfica não verificada. |
| Quais classes, campos e métodos existem? | Inventário DEX inteiro dos dois arquivos | TSV e [parser](ferramentas/inventariar_dex.py) | Declaração não recupera corpo JNI; nomes ofuscados podem esconder significado. |
| Catálogo/EPG ficam em RAM ou disco? | Mecanismos locais identificados | [02](02-armazenamento.md), [03](03-catalogo-e-rede.md), [04](04-epg-e-atualizacao.md) | Consumo real e conteúdo de um dispositivo não foram medidos. |
| Quem fornece os dados? | Pedidos/consumidores identificados | [03](03-catalogo-e-rede.md) | Implementação do backend e respostas atuais não foram fornecidas. |
| Qual é a política de atualização? | Defaults e gatilhos Java identificados | [03](03-catalogo-e-rede.md), [04](04-epg-e-atualizacao.md) | Conta/configuração real, reflexão/JNI e agendamento do Android não foram observados. |
| A grade é consultada remotamente por célula? | Fluxo Java rastreado usa arquivo e estruturas locais | [04](04-epg-e-atualizacao.md) | Não é uma captura de tráfego de todo o aplicativo. |
| Como parser escolhe canal/dia/programa? | Estruturas e chamadores atuais; parte dos algoritmos protegidos tem contrato histórico do mesmo SHA | [04](04-epg-e-atualizacao.md) | Mapeamento completo da VM nativa não foi refeito; empates e todos os casos limite não foram certificados. |
| Os timers param fora da tela? | `onDestroy` e proteção de referências confirmados | [06](06-componentes-e-ciclo-de-vida.md) | `onPause/onStop` e parte do cancelamento são protegidos. |
| Qual engine recebe cada mídia? | Adaptadores, carregadores, JNI e parte das arestas identificados | [05](05-reproducao-e-memoria.md) | Seleção efetiva, fallback, retry e disponibilidade por stream não foram observados. |
| Quanta RAM/buffer/disco usa? | Defaults empacotados e mecanismos identificados | [02](02-armazenamento.md), [05](05-reproducao-e-memoria.md) | Defaults não são RSS, heap total, configuração efetiva do player ou limite do transporte P2P. |
| O fornecedor não usa Supabase? | Busca literal delimitada negativa no cliente | [01](01-identidade-metodo-e-cobertura.md) | Não é possível determinar o banco do servidor nem excluir dependência oculta. |
| A segunda distribuição faz tudo igual? | Inventário e comparação binária completos | [07](07-comparacao-das-distribuicoes.md) | Fluxos de comportamento foram aprofundados no primário; equivalência semântica integral da 12.0.3 não foi demonstrada. |

## Registro de evidências

- [evidencias-rea.json](evidencias-rea.json): índice sanitizado dos envelopes REA efetivamente preservados, com operação, seletor, SHA do alvo e hash do arquivo privado. Não contém corpos de código nem constantes.
- [inventario-artefatos.json](inventario-artefatos.json): hashes de todos os membros ZIP e comparação entre distribuições.
- [resumo primário](resumo-dex-primary.json) e [BinStream](resumo-dex-binstream.json): contagens DEX e fronteira exata da busca literal.
- Os sidecars temáticos de catálogo/EPG e reprodução conservam seus próprios localizadores e classificação de corpo; os capítulos apontam os arquivos correspondentes.

Uma referência histórica é identificada como tal, mesmo quando o relatório declara o SHA correto. Hash do APK não recupera um dump temporário perdido. Evidências atuais obtidas novamente da mesma classe são separadas das conclusões anteriores de VM.

## Limites das ferramentas

REA/JADX permite recuperar inventário e muitos corpos Java. Mensagens genéricas de “sem corpo” exigiram conferência direta das flags e tabelas DEX; os valores de timers foram recuperados assim. Métodos efetivamente `native` não ganharam corpo Java por serem passados ao decompilador.

Não havia engine nativa Ghidra/Hopper/IDA configurada no REA desta sessão. Bibliotecas nativas foram lidas por estrutura ELF, símbolos, hashes e strings, com fronteiras JNI e relatórios históricos explicitados. Isso não é uma reconstrução completa de todos os algoritmos ARM/Go ou da máquina virtual de proteção.

O código/artefato estático não responde sobre servidores disponíveis, tráfego do dia, reprodução atual, consumo medido de CPU ou vida de um processo real. A documentação registra mecanismos e perguntas abertas para orientar a próxima mudança, sem declarar essas lacunas resolvidas.
