# Revisão do consumo de consultas a logs

Data:16/10/2026 local,17/10 UTC. Pedido: três agentes para investigar o crescimento do medidor e confrontar a documentação dos APKs. Revisão de documentação oficial, código atual e capturas; zero consultas aos logs do projeto, nenhuma operação remota, teste, navegador ou execução de APK nesta etapa.

## O que a captura mede

| Campo às23h08 | Valor observado | Interpretação |
| --- | --- | --- |
| Log Query, organização | 97,828GB /100GB | Volume acumulado varrido em consultas de logs |
| Log Query, ARKHEN | Aproximadamente93,89GB | Parcela do projeto autorizado |
| Log Query, outro projeto | Aproximadamente3,94GB | Fora do escopo de operação desta revisão |
| Log Ingestion, organização | 0,262GB /1GB | Logs recebidos durante o ciclo, não estoque retido |
| Storage Size | 0,139GB /1GB | Medidor de armazenamento separado |

O ciclo exibido é15/10–15/11, com filtro All projects. [Logs Query](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query) contabiliza a varredura feita pelo Studio/API/CLI e outras interfaces. Repetir a consulta pode contar os mesmos dados novamente. Exemplo ilustrativo:250MB lidos60 vezes somam15GB consultados; isso não cria15GB de arquivos. [Logs Ingest](https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest) mede a entrada de registros dos serviços.

O anúncio oficial de[25/09/2026](https://supabase.com/changelog/logs-usage-based-pricing) descreve o rótulo Upcoming como informativo durante a carência atual. Não há evidência de que atingir100GB nesta captura interromperia o aplicativo. A política futura e a carência devem ser reconferidas quando houver decisão de plano; nenhuma cobrança ou upgrade foi autorizado/feito aqui.

## Resultado das três frentes

1. **Plataforma:** o [MCP oficial](https://raw.githubusercontent.com/supabase/mcp/main/packages/mcp-server-supabase/src/tools/debugging-tools.ts) resolve janela omitida como últimas24h em `get_logs` e `query_logs`. As descrições orientam não executar essas ferramentas em loop. Isso é um mecanismo capaz de elevar rapidamente o consumo, sem identificar qual cliente produziu o histórico do ARKHEN.
2. **Aplicação e ferramentas:** não foi encontrado consumidor de Logs Query no código auditado. `SupabaseCloud.request` e o gateway restringem os caminhos comuns a Auth/REST; os crons conhecidos despacham trabalho de catálogo/marcadores. O helper administrativo usa SQL PostgreSQL ou saúde; seu comando manual `metrics` lê contadores, sem consulta temporal de logs. Console do navegador/servidor produz diagnóstico, não varredura de logs.
3. **APK:** a documentação comprova cache manual em disco/RAM, EPG por arquivo e seleção local. Também comprova inicialização de Xlog e CrashReport. A ausência de literais Supabase nos APKs não revela a tecnologia ou observabilidade dos servidores do fornecedor. Remover a biblioteca privada ou migrar os cálculos do ARKHEN não é correção demonstrada para este medidor.

Fontes de código: `lib/supabase-cloud.mjs`, `supabase/functions/arkhen-backend/handler.mjs`, `tools/supabase-project.mjs`, `lib/catalog-revision-service.mjs`, `lib/cloud-runtime.mjs`, `web/cloud-library.js` e migrations dos agendadores. A busca cobriu runtime, ferramentas e SQL; não auditou clientes administrativos externos, outras sessões ou todo o histórico do painel.

Fontes APK: [armazenamento e logs](engenharia-reversa-wplay-20261016/02-armazenamento.md), [catálogo/rede](engenharia-reversa-wplay-20261016/03-catalogo-e-rede.md), [limites da prova](engenharia-reversa-wplay-20261016/01-identidade-metodo-e-cobertura.md) e [consequências arquiteturais](engenharia-reversa-wplay-20261016/08-consequencias-para-o-arkhen.md).

ARKHEN já possui cache por revisão, agrupamento de consultas, espera progressiva e suspensão de timers sem consumidores. Essas medidas reduzem trabalho do produto e podem reduzir logs gerados; não controlam consultas administrativas feitas por outro cliente. Código local e versão publicada continuam evidências distintas.

## Procedimento adotado para conter novas varreduras

- Regra adicionada ao `AGENTS.md`: diagnóstico comum sem Logs Query. Priorizar `health`, metadados limitados de atividade, contadores PostgreSQL e ciclos naturais. Não transformar essas alternativas em polling agressivo do banco.
- Uma investigação que realmente precisar de logs deve delimitar projeto, serviço e início/fim do incidente; começar por5–15min, reutilizar a resposta sanitizada e ampliar somente com necessidade concreta. Um limite de linhas não garante pouco trabalho de leitura. Referência:[filtragem de logs](https://supabase.com/docs/guides/observability/advanced-log-filtering).
- Nas ferramentas externas/painel, interromper atualizações automáticas que efetivamente consultem logs. Não atribuir esse comportamento a toda tela de CPU, Observability ou Usage sem identificar a consulta. Esta etapa não abriu nem alterou o navegador pessoal.
- Se acompanhamento contínuo de logs se tornar necessário, desenhar a coleta separadamente; não instalar serviço, Log Drain ou custo novo como efeito desta revisão.

O aplicativo auditado pode operar sem consultar o histórico de logs. Isso não elimina os registros automáticos produzidos pela plataforma. Desligar todos os registros PostgreSQL ou apagar dados não é necessário para evitar consultas repetidas.

## Como conferir o efeito

Manter o mesmo projeto e ciclo ao comparar medições. A captura informa atualização de uso com atraso de até1h: crescimento logo após suspender consultas pode representar uso anterior contabilizado depois. O total acumulado não precisa cair; o que deve cair é o incremento entre amostras comparáveis. Conferir tendência por mais de uma janela, com uma leitura pontual de Usage, sem voltar a consultar os logs para monitorar o próprio consumo.

Não foi identificado o autor dos93,89GB históricos do ARKHEN nem comprovada ainda a redução futura do contador. O achado verificável é a distinção dos medidores e ausência de consumidor no código auditado. A mudança aplicada é operacional, nas instruções dos agentes; não representa bloqueio técnico de ferramentas externas ou alteração de configuração do Supabase.

## Etapas para atribuir e corrigir o consumo com evidência

1. **Fixar a medição.** Usar somente o projeto ARKHEN e o mesmo ciclo. A amostra disponível às23h08 é93,89GB no projeto,97,828GB na organização. Registrar horário/valor e comparar deltas, considerando atraso de até1h. Essa amostra não é um medidor em tempo real.
2. **Localizar um consumidor observado.** Correlacionar chamadas atuais com ferramenta, rota, frequência e intervalo temporal. Na auditoria local complementar,127 arquivos de sessões de16/10 cujo diretório coincide com este repositório foram selecionados pelo cabeçalho. Foram examinados somente registros estruturados de chamadas; nenhuma chamada nominal direta ou via `tools.*` a `get_logs`/`query_logs` foi encontrada. A checagem cobriu os formatos `function_call` e `custom_tool_call`, com deduplicação pelo identificador da chamada. Não prova ausência de chamada construída dinamicamente, shell, painel, clientes externos ou registros de outros dias. Conversas e payloads de resultados não foram copiados. O próximo passo é observação de requisições administrativas, dentro das permissões do usuário.
3. **Intervir no consumidor comprovado.** Registrar a configuração anterior e interromper ou reduzir somente a consulta recorrente identificada. Reutilizar resultado e estreitar intervalo/serviço quando houver leitura necessária. Não promover a mera presença de uma aba, ferramenta ou timer a causa. Se forem vários consumidores, registrar cada intervenção separadamente; não repetir varreduras largas deliberadamente só para produzir contraste.
4. **Verificar o efeito.** Após o atraso de contabilização, comparar pelo menos duas janelas de uso do mesmo projeto. Correlacionar a ausência/redução das chamadas observadas com menor incremento do medidor. Conferir saúde dos serviços e funcionamento pelo uso normal autorizado. Sem melhora, ampliar a investigação dos consumidores ainda não observados, sem declarar solução.
5. **Consolidar a prevenção.** Manter a regra operacional já escrita; quando um script/cliente real for identificado, aplicar limite técnico de frequência/intervalo nesse consumidor. Registrar antes/depois, origem comprovada, mudança, possibilidade de reversão e limitações. Uma instrução no `AGENTS.md` não substitui esse controle técnico.

Segundo a[documentação de auditoria](https://supabase.com/docs/guides/security/platform-audit-logs), a auditoria organizacional completa é de Team/Enterprise; registros da própria conta são uma superfície distinta. Portanto o Free não oferece automaticamente uma atribuição organizacional completa. Não foi presumido que registros disponíveis incluam todas as consultas históricas.

A inspeção de navegador permanece condicionada à instrução atual do usuário que a proíbe, preservada no `AGENTS.md`; nenhuma navegação foi feita nesta auditoria. O roteiro acima não implica que o consumidor já tenha sido encontrado ou desativado.
