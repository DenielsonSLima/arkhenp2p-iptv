# Estabilização da TV ao vivo — 15/10/2026

Solicitação: corrigir reinício do carregamento, desaparecimento da programação e aviso de interrupção durante a reprodução, vistos nas três capturas enviadas às 15:21–15:22. A inspeção final da experiência é do usuário; as provas internas distinguem simulação e serviço real.

## Divisão da revisão

| Responsável | Caminho analisado |
| --- | --- |
| sync_registry_backend | Requisição do navegador → autorização/seleção → sessão OTT → manifesto/segmentos; cancelamento, concorrência e prazo de abertura. |
| sync_registry_ui | HLS/native → recuperação → estado visual; callbacks atrasados, orçamento inicial, contadores de erro e preparação da mesma fonte. |
| catalog_completion | Canal selecionado → cache de programação → player/vizinhos/cards; atualização vazia, namespace e validade temporal. |
| principal | Integração, suíte completa, bundle/licenças, documentação e revisão do conteúdo publicado no GitHub. |

## Problemas identificados no código anterior

- O manifesto inicial tinha somente 4 s até o primeiro byte/8 s no total. Antes de responder, o backend podia precisar autenticar OTT, carregar seu catálogo e abrir a fonte. As tarefas externas tinham limites individuais maiores que o limite do navegador.
- O cancelamento invalidava respostas da preparação OTT, mas não interrompia todos os RPCs que mantinham a fila ocupada.
- Duas requisições GET/HEAD do mesmo canal podiam disputar a geração de seleção, retornando 409 para a anterior como se o usuário tivesse escolhido outro canal.
- O tratamento de erro podia continuar depois de uma troca síncrona de fonte iniciada pela qualidade automática. O callback antigo então alcançava o player/HLS seguinte.
- A interface tratava um evento de erro do elemento de vídeo como falha definitiva mesmo durante a recuperação HLS. O orçamento de recuperação também acumulava interrupções já recuperadas durante toda a sessão.
- Reiniciar a preparação da mesma fonte apagava a grade: o feed emitia uma lista vazia antes de buscar a programação. Uma resposta vazia de atualização também substituía a grade ainda vigente nos feeds.

Os intervalos de detecção, o timeout inicial e os limites de retentativa não comprovam a disponibilidade do provedor. O objetivo é preservar uma reprodução válida, encerrar trabalho obsoleto e apresentar falha definitiva somente depois das tentativas pertinentes.

## Verificação

Os patches foram integrados e os três responsáveis congelaram os arquivos antes da conferência final.

| Verificação | Resultado |
| --- | --- |
| Suíte completa, `node --test tests/*.test.mjs` | 1.053 testes: 1.052 passaram, zero falhas, um skip de symlink no Windows; 6,1 s. Log privado `.local/release-live-suite-final.log`. |
| Aplicação real em Chromium isolado | HLS, mídia e provedor simulados: preparação após 4 s, recuperação sem falha prematura, pausa voluntária, eventos duplicados, fallback da mesma família, programação vigente e erro tardio da instância anterior passaram. Zero exceções/console.error. |
| Continuidade do carregamento | Preparação de 9 s conservada na alternativa automática; modo compacto após início da reprodução; loader removido depois da recuperação. |
| Bundle Supabase/TanStack | `npm run build:cloud` passou e incluiu licenças de dez dependências. |
| Grafo de imports da interface | 79 módulos compilados sem avisos, respeitando o mesmo mapeamento da raiz web; nenhuma saída adicional gravada. |
| Ativação local | Backend reiniciado uma vez às 19:08:58 UTC. HTML e seis módulos responderam HTTP200/no-cache; sessão nova respondeu200/desconectada e mídia sem login respondeu401. |

Detalhes dos patches: [cliente](live-client-recovery.md), [EPG](live-epg-stability.md) e [transporte](wplay-playback-contract.md). Evidências privadas `.local/live-recovery-browser-result.json`, `.local/live-recovery-browser.png` e `.local/release-serving-evidence.json`. Os processos temporários foram encerrados; o aplicativo principal permanece na porta4173.

O reinício encerrou a sessão local em memória: a próxima entrada exige o login normal. Nenhuma transmissão prolongada real é declarada validada por esse fixture; não houve login WPLAY real nem consumo de conexões da assinatura nos testes desta correção.

## Estado separado do Supabase

Os testes oficiais de saúde às 18:54:49 e 19:12:23 UTC retornaram `UNHEALTHY` para banco, Auth, REST e Storage. Esse problema foi observado separadamente da análise do transporte de TV. O [registro de saúde](../reports/supabase-project-health-2026-10-15.json) não identifica a causa. A confirmação do lote de referências de abertura continua pendente, conforme a [auditoria de marcadores](marker-target-audit-2026-10-15.md).

Alternativas públicas para os tempos de abertura foram pesquisadas em paralelo: [AniSkip/AnimeSkip](../reports/marker-alternative-anime-2026-10-15.md) e [detecção por áudio](../reports/marker-alternative-detection-2026-10-15.md). Elas não foram habilitadas automaticamente no player.
