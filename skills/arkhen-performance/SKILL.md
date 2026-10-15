---
name: arkhen-performance
description: Otimizar carregamento, memória e estabilidade visual do ARKHEN IPTV, com medição do caminho de dados por domínio.
---

Leia `docs/engineering-recovery.md` no repositório ARKHEN para decisões e critérios atuais.

Meça a operação que falha antes de otimizar: provedor, Edge/RPC, publicação, transferência, cache ou render. Um timeout na última operação pode incluir todo o orçamento consumido antes dela; registre tempos por fase.

Filmes, séries e TV mantêm estados e tarefas independentes. Preserve o último snapshot válido durante atualização/erro. Compare revisão, completude, conta e tipo antes do commit. Não tratar favoritos ou uma prévia como catálogo completo.

Carregue metadados completos para busca e cache diário; monte cards/imagens conforme navegação. Evite cópias cumulativas, promessas resolvidas retidas e renderizações globais em eventos de progresso/EPG.

Verifique transições com resposta atrasada, offline e Realtime. Diferencie teste sintético, publicação remota e reprodução real. A validação final da experiência fica com o usuário após a verificação interna.
