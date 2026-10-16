# Memória técnica do ARKHEN

Corpus local curado, sem dados de contas. Atualizado em 15/10/2026. Estes registros não consultam o estado remoto nem executam mídia.

## MEM-INDEX-001 — Recuperação e fontes

Estado: contrato de manutenção. Data: 15/10/2026.

Use `node tools/retrieve-memory.mjs "termos" --domain live --limit 5`. Domínios: [TV](live.md), [Filmes](movies.md), [Séries](series.md) e [compartilhado](shared.md). A recuperação é textual, limitada e sem embeddings. Leia o código/documento citado antes de alterar comportamento.

Cada registro conserva ID, data, estado, decisão e fontes. `Contrato` descreve um limite pretendido do produto; `histórico` descreve evidência datada; `em implementação` não garante integração, deploy ou funcionamento; `hipótese` requer investigação. Não reclassifique esses estados sem a evidência correspondente.

Fontes gerais: [arquitetura](../catalog-architecture.md), [mapa do player](../player-modules.md), [registro de engenharia](../engineering-recovery.md). O registro de engenharia contém várias etapas históricas; uma etapa posterior pode substituir uma anterior.

## MEM-INDEX-002 — Privacidade e atualização

Estado: contrato de manutenção. Data: 15/10/2026.

Não armazenar credenciais, cookies, tokens, chaves, endereços privados/assinados de reprodução, biblioteca, favoritos ou progresso pessoal. Não copiar `.local`, `.env`, logs brutos ou perfis de navegador. Configuração de infraestrutura não faz parte deste corpus. OpenContext global e seu índice não são modificados pela recuperação do projeto.

Registre somente decisões reutilizáveis, causas demonstradas e limites da prova, com links para fontes sanitizadas. Contagens de catálogo e saúde remota são observações datadas, não constantes ou garantias atuais.
