# Engenharia reversa dos APKs WPLAY

Investigação de 16/10/2026, com três agentes e integração principal. Objetivo: explicar como os APKs recebem, armazenam, atualizam e apresentam catálogo/EPG, e como entregam a reprodução ao dispositivo, antes dos próximos ajustes do ARKHEN.

**O desenho encontrado combina servidor, RAM e disco local.** Catálogo vem de pedidos HTTP do fornecedor e é convertido em objetos locais. Há cache manual em disco, separado de `NO_CACHE` HTTP. EPG é baixado para `cacheDir/epg.data` e consumido por mapas/cache em memória por canal/dia. Portanto, não é somente RAM. Também não se pode conhecer o banco usado dentro do servidor a partir desse cliente.

O APK primário define EPG de 30 em 30 minutos, intervalo automático de catálogo inicialmente desabilitado (`-1`) e validade padrão de cache de 14 dias. São valores iniciais recuperados do DEX: validade do cache não equivale a intervalo de download, e a inicialização ainda pode pedir dados. Sobrescritas, gates e encerramento são discutidos nos documentos específicos.

## Mapa da documentação

| Documento | Perguntas respondidas |
| --- | --- |
| [01 — Identidade, método e cobertura](01-identidade-metodo-e-cobertura.md) | Quais APKs, versões, hashes, ferramentas e limites sustentam a análise? |
| [02 — Armazenamento e cache](02-armazenamento.md) | O que fica em RAM, disco, preferências ou banco local? Como expira? |
| [03 — Catálogo e rede](03-catalogo-e-rede.md) | Quem entrega os dados, como o catálogo é montado e quais pedidos se repetem? |
| [04 — EPG e atualização](04-epg-e-atualizacao.md) | Como o arquivo vira grade, como canal/dia é selecionado e quando se atualiza? |
| [05 — Motores e reprodução](05-reproducao-e-memoria.md) | Quais transportes, decoders e buffers estão declarados ou têm fluxo comprovado? |
| [06 — Componentes e ciclo de vida](06-componentes-e-ciclo-de-vida.md) | Activity, services, callbacks, timers e encerramento: o que está exposto? |
| [07 — Comparação das distribuições](07-comparacao-das-distribuicoes.md) | O que muda entre 11.9.0d e 12.0.3 e o que pode ser reutilizado como prova? |
| [08 — Consequências para o ARKHEN](08-consequencias-para-o-arkhen.md) | Que decisões essa evidência permite preparar, sem alterar o sistema agora? |
| [09 — Evidências e lacunas](09-evidencias-e-lacunas.md) | O que foi respondido, o que depende de código protegido e o que permanece desconhecido? |
| [Ferramentas e reprodução](ferramentas/README.md) | Como regenerar inventários sem executar o aplicativo? |

## Perguntas centrais

| Pergunta | Resultado e limite |
| --- | --- |
| Catálogo e EPG ficam no dispositivo? | Sim, há estruturas em RAM e arquivos locais; são dados recebidos de serviços, não conteúdo inventado localmente. |
| O APK depende diretamente do Supabase? | Não foram encontrados os nomes/rotas buscados nos literais dos DEX e bibliotecas dos dois APKs. Criptografia, JNI, carregamento dinâmico e interior dos servidores impedem provar ausência global. |
| A grade exige consultar um banco remoto a cada célula/minuto? | O fluxo Java rastreado usa arquivo EPG e seleção/cache local; não foi visto pedido HTTP por célula. Isso não é uma medição de tráfego real. |
| `NO_CACHE` significa baixar sem nenhum cache? | Não. Os callbacks escrevem/leem um cache manual próprio. |
| O catálogo só é baixado a cada 14 dias? | Não. Esse valor é validade de cache; inicialização, mensagens e fallback têm caminhos próprios. |
| Fechar a tela encerra tudo? | `onDestroy` limpa mensagens e referências. Partes de pausa/retomada e cancelamento são protegidas; background completo permanece parcialmente desconhecido. |
| Ter `libijkplayer.so` prova que a reprodução usa IJK? | Não. O nome da biblioteca não demonstra sua função ou seleção; o caminho de carregamento e os símbolos precisam ser rastreados. |
| O APK prova como economizar CPU no ARKHEN? | Mostra mecanismos locais e ciclos úteis para o desenho. Não mede a CPU do ARKHEN nem prova que remover um banco resolveria o incidente. |

## Inventário do pacote inteiro

O [inventário de artefatos](inventario-artefatos.json) cobre todos os membros ZIP, tamanhos e hashes de ambos os arquivos. Os índices DEX incluem classes internas, métodos, campos, flags e offsets de todas as declarações:

| Artefato | Classes | Métodos definidos | Campos definidos | Índices |
| --- | ---: | ---: | ---: | --- |
| WPLAY 11.9.0d | 10.277 | 66.249 | 42.161 | [classes](classes-primary.tsv), [métodos](metodos-primary.tsv), [campos](campos-primary.tsv), [resumo](resumo-dex-primary.json) |
| BinStream 12.0.3 | 10.290 | 66.318 | 42.195 | [classes](classes-binstream.tsv), [métodos](metodos-binstream.tsv), [campos](campos-binstream.tsv), [resumo](resumo-dex-binstream.json) |

Há 1.939 membros comuns idênticos e 521 diferentes, além de membros exclusivos. Os dois arquivos não podem compartilhar offsets ou conclusões automaticamente. O [resumo de identidade/componentes](identidade-e-componentes.json) e os manifests [primário](manifest-primary.xml)/[BinStream](manifest-binstream.xml) vinculam as declarações às respectivas versões.

Inventário completo não significa que os 66 mil métodos tenham seu algoritmo recuperado. A análise de comportamento aprofunda os fluxos relevantes do primário; bibliotecas nativas, proteção e métodos sem corpo recuperado permanecem explicitamente delimitados. Cada documento conserva símbolos, offsets e Evidence IDs em vez de preencher lacunas por suposição.

## Fronteiras preservadas

Esta etapa produziu documentação e ferramentas de leitura. Não executou APK, emulador, login, mídia ou testes do aplicativo. Não fez novos ajustes no banco ou publicação do ARKHEN. Os dados pessoais, credenciais e fontes privadas não fazem parte desta pasta; os envelopes de análise integrais permanecem em área privada.

O [relatório anterior de carga](../supabase-load-optimization-20261016.md) mantém o estado das alterações Supabase já realizadas e das medições ainda não certificadas. A engenharia reversa não encerra automaticamente esse incidente.
