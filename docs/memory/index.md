# Memória técnica do ARKHEN

Corpus local curado, sem dados de contas. Atualizado em 17/10/2026. Estes registros não consultam o estado remoto nem executam mídia.

Séries: [marcadores por episódio em reprodução](../series-markers-on-demand-20261017.md), busca após `playing`, cache limitado e contagem cancelável de 5 segundos com salto automático também nos horários comunitários, por correção posterior do usuário. Diferenças até 5s toleradas. Coleta cron global desativada/readback confirmado. Validação anterior de APIs e 101 testes; ajuste posterior da contagem com 82 testes e arquivos servidos pelo localhost, sem certificação audiovisual no Safari.

Revisão atual: [isolamento de Home TV, VOD e sugestões](../home-recommendations-isolation-20261017.md). Duas RPCs aditivas publicadas e rotas validadas com login normal; TV não bloqueia a preparação VOD. [Cache EPG por canal](../tv-guide-memory-cache-20261017.md) conserva janelas válidas durante navegação e reprodução, com proprietário/PIN/revisão próprios. A prova HTTP é distinta da interface Safari, cujo controle remoto permaneceu indisponível.

Revisão posterior: [Home TV semanal e sugestões de Filmes](../home-movie-recovery-20261017.md). Quatro frentes reunidas, bind sem escritas repetidas, janela TV de168h aplicada/readback conferido e consultas de Filmes coalescidas. Depois, testes internos foram autorizados; capturas e confirmação do usuário mostraram recuperação após reinício do Supabase. Novo pedido: [cinco canais com prévia e programação](../home-tv-five-cards-20261017.md), SQL aplicada e testes sintéticos; sem navegador/mídia real.

Revisão seguinte: [abertura/qualidade de TV e Home sem prévia](../tv-playback-recovery-20261017.md). Capturas reais ainda falharam; nova rodada corrigiu eventos atrasados, [descoberta de fontes](../tv-source-discovery-20261017.md) e pausa de catálogo durante vídeo.148testes integrados passaram; servidor local ativado, estabilidade real pendente.

Evidência real de 17/10: [identidade dos segmentos web OTT](../tv-web-segment-identity-20261017.md). Rotação de `token` alterava URIs locais para bytes iguais. Correção restrita ativada; playlists reais passaram a manter identidade. Latência inicial e continuidade audiovisual permanecem pendentes.

Sessão e UI: [reconciliação após perda da sessão](../session-loss-reconciliation-20261017.md). Reinícios apagam sessões em RAM; a interface agora reconhece perda confirmada. 55 testes internos, sem novo reinício do servidor real.

Investigação das capturas das 11:17: [prontidão de TV e decodificação real](../tv-native-readiness-audit-20261017.md). Corrigidos carregamento persistente após evento precoce e ticket de troca pendente. AVFoundation pelas rotas locais: Globo60s sem stall; Record300s com dois stalls iniciais, sem novas interrupções. Não certifica Safari; descoberta fria continua lenta. [Revalidação cloud](../cloud-artwork-validation-recovery-20261017.md): timeout não deve revogar JWT ainda válido; ativada no reinício local conferido às13:00BRT.

Associação de TV: [HBO Plus e qualificador H265](../tv-channel-mapping-codec-20261017.md). O resolvedor apagava H265 e criava falsa ambiguidade entre identidades OTT distintas. Preferência pelo título completo com codec preservado; duplicatas exatas continuam bloqueadas. 40 testes únicos e metadados reais confirmam três fontes web SD/HD/FHD para o canal467, padrãoFHD; ativada localmente, sem certificação audiovisual no Safari.

## MEM-INDEX-001 — Recuperação e fontes

Estado: contrato de manutenção. Data: 15/10/2026.

Use `node tools/retrieve-memory.mjs "termos" --domain live --limit 5`. Domínios: [TV](live.md), [Filmes](movies.md), [Séries](series.md) e [compartilhado](shared.md). A recuperação é textual, limitada e sem embeddings. Leia o código/documento citado antes de alterar comportamento.

Cada registro conserva ID, data, estado, decisão e fontes. `Contrato` descreve um limite pretendido do produto; `histórico` descreve evidência datada; `em implementação` não garante integração, deploy ou funcionamento; `hipótese` requer investigação. Não reclassifique esses estados sem a evidência correspondente.

Fontes gerais: [arquitetura](../catalog-architecture.md), [mapa do player](../player-modules.md), [registro de engenharia](../engineering-recovery.md). O registro de engenharia contém várias etapas históricas; uma etapa posterior pode substituir uma anterior.

Fontes atuais de estabilização em 16/10: [WPLAY sem ponte experimental](../wplay/README.md), [incidente Supabase](../supabase-incident-20261016.md) e [auditoria de carga/retenção](../home-identity-cron-20261016.md). Preparação local não certifica deploy, contenção remota ou mídia.

O [relatório de otimização de carga](../supabase-load-optimization-20261016.md) registra as alterações posteriores de banco/workers e código do cliente, os primeiros ciclos que ainda falharam e os limites das observações. Consultar esse registro antes de retomar definições antigas ou atribuir bytes de Logs Query ao armazenamento do banco.

A [revisão específica de Logs Query](../supabase-log-query-review-20261016.md) reúne três frentes: métrica oficial, consumidores no código e comparação com APK. Priorizar diagnóstico sem consultas de logs; a regra operacional está no `AGENTS.md`. Contador acumulado de varredura não mede armazenamento nem identifica o autor das consultas.

A [aplicação em três etapas](../otimizacao-sistema-supabase-20261016.md) identifica as versões efetivas posteriores: cache por revisão, TV/EPG sob demanda sem clock global e manutenção por fases/páginas, com worker de marcadores versão 8. Código do site permanece local; schema/workers confirmados e alguns ciclos curtos não encerram o incidente de CPU.

Antes dos próximos ajustes, consultar o [dossiê de engenharia reversa dos APKs WPLAY](../engenharia-reversa-wplay-20261016/README.md): separa versões por hash, armazenamento em RAM/disco, cache manual/HTTP, EPG, engines e fronteiras protegidas. A ausência de um nome Supabase no cliente não certifica a arquitetura do servidor.

Prioridade posterior em 16/10: [modularização de Séries](../series-modularization-20261016.md), integrada localmente e validada com dados sintéticos. Os defeitos operacionais anteriores permanecem em etapas posteriores; não houve teste visual ou publicação nessa reorganização.

Revisão seguinte: [conexão WPLAY e arquitetura integrada](../architecture-review-wplay-20261016.md), com provedores/autenticação e serviços por domínio em `lib/wplay/`, conectores temporais de Séries separados e remoção dos caminhos substituídos. Evidência inicial: 400 testes sintéticos selecionados e bundles locais.

Limpeza posterior: [estratégia EPG e contratos de testes](../epg-architecture-cleanup-20261016.md), com [prova estática do APK](../wplay/epg-apk-20261016.md), prioridade da publicação compartilhada e recuperação WPLAY condicional. Testes legados foram atualizados; disponibilidade remota continua separada. Entradas TV repetitivas foram resumidas porque o arquivo excedia o limite de recuperação, preservando IDs e fontes.

## MEM-INDEX-002 — Privacidade e atualização

Estado: contrato de manutenção. Data: 15/10/2026.

Não armazenar credenciais, cookies, tokens, chaves, endereços privados/assinados de reprodução, biblioteca, favoritos ou progresso pessoal. Não copiar `.local`, `.env`, logs brutos ou perfis de navegador. Configuração de infraestrutura não faz parte deste corpus. OpenContext global e seu índice não são modificados pela recuperação do projeto.

Registre somente decisões reutilizáveis, causas demonstradas e limites da prova, com links para fontes sanitizadas. Contagens de catálogo e saúde remota são observações datadas, não constantes ou garantias atuais.
