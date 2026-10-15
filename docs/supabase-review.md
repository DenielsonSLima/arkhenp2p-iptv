# Revisão da entrega Supabase — 15/10/2026

Projeto consultado e alterado: `wnicimkmzswksaqdtgdv`, ArkhenP2IPTV. As verificações usaram a Management API oficial com credencial local temporária; nenhum MCP de outro projeto foi alterado.

| Pedido | Estado verificado |
| --- | --- |
| Conexão do projeto | Serviço remoto `ACTIVE_HEALTHY`; cinco migrations registradas |
| Tabelas e RLS | 12 públicas e 3 privadas com RLS; teste positivo/negativo remoto passou com rollback e zero fixtures restantes |
| Pré-cadastro WPLAY | Implementado após validação da conta no provedor; nenhuma senha WPLAY é armazenada no Supabase |
| Favoritos, minha lista e coleções | Dados por usuário e provedor, com exclusões persistentes e fila offline |
| Continuar assistindo | Progresso separado por título e por ID exato de episódio |
| Preferências entre plataformas | Áudio, player, ordenação, catálogo e coleções sincronizados por conta |
| TanStack Query e Realtime | Query Core integrado; 12 tabelas públicas na publicação; eventos de catálogo revalidam os snapshots abertos |
| Catálogo global | Atualização diária pelo worker; itens ausentes só são desativados após snapshot completo bem-sucedido |
| Programação e jogos globais | Cadências de 5 minutos e 1 minuto; coleta compartilhada por origem, com fila, leases e proteção contra duplicação |
| Abertura e créditos | 1.132 referências gravadas: 1.049 edições SkipDB das 14 séries, mais 83 referências anteriores; conflitos e durações incompatíveis não acionam saltos |
| Histórico com crescimento limitado | Retenção diária de EPG após 7 dias e agendas de jogos antigas/expiradas após 30; não remove bibliotecas pessoais |

## Correções feitas na revisão

- Sessões independentes para logins simultâneos da mesma conta em aparelhos diferentes.
- Falha temporária na primeira consulta não revoga o refresh token válido.
- Capas, logos, miniaturas e imagens dos jogos aceitam os identificadores compartilhados seguros.
- Eventos Realtime substituem o catálogo exibido sem pedir nova coleta WPLAY; o backend permite reler o snapshot confirmado sem sua memória de cinco segundos.
- Licenças das dez dependências incluídas no bundle são geradas e distribuídas junto dele.
- Download real de 90 logos de times e ligas, com cache local persistente e rota autenticada.
- Sincronização diária de SkipDB e exportação pública dos horários/licenças, separada das bibliotecas pessoais. A proteção de conteúdo final impede que o modo aproximado corte uma prévia conhecida.
- Publicação de catálogo e EPG em operações por conjunto; dados inalterados não geram novos UPDATEs. Três funções de publicação têm prazo próprio de 55 segundos, sem ampliar os prazos de login ou de consultas dos usuários.

Os advisors finais não apontaram ERROR de banco. Há um WARN de Auth: `Leaked Password Protection Disabled` permanece desativado no projeto. A aplicação valida a senha WPLAY no provedor e usa sessão OTP com senha Auth aleatória; essa proteção do Supabase não verifica senhas WPLAY. Os três INFO de tabelas privadas sem políticas refletem o bloqueio intencional de clientes. Três índices ainda aparecem sem uso; foram preservados por atenderem consultas de categorias, programação e retenção.

## Validação com a conta real

Após a entrada válida no WPLAY, a consulta remota confirmou **1 perfil, 760 canais, 50.209 registros de programação e uma agenda de jogos compartilhada**. O catálogo de filmes e séries ainda estava em coleta; esses totais não comprovam sua conclusão.

`node tools/verify-cloud-live.mjs` passou usando duas sessões temporárias independentes do perfil já validado: conexão pela biblioteca real, gravação de uma preferência temporária, entrega por Realtime e renovação da segunda sessão após logout da primeira. A preferência foi removida e somente as sessões do teste foram encerradas. O comando exige exatamente um perfil ativo recente ou `--user-id UUID`; não faz parte de `npm test` nem cria contas fictícias.

O Cron do banco agenda a fila; a coleta precisa do **backend Node ligado e de uma fonte WPLAY autenticada**. Não existe coleta autônoma do WPLAY pelo Supabase enquanto esse backend estiver desligado. Os vídeos continuam vindo do provedor.

A suíte final passou com **653 testes**. A integração PostgreSQL adicional passou em 25 verificações com 1.100 títulos e 1.200 programas, incluindo publicação atômica, ausência de UPDATEs para conteúdo idêntico, validação e preservação de privilégios. O servidor local foi reiniciado para carregar as mudanças; a causa do erro de reprodução 502 reportado pelo usuário ainda depende de uma nova tentativa, agora com diagnóstico de código/status sem URLs ou credenciais.

Referências de manutenção: [configuração](supabase-setup.md), [backend](supabase-backend.md), [cliente](cloud-library-client.md), [retenção](supabase-retention.md), [SQL/RLS](../supabase/README.md).
