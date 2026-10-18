# Conexão WPLAY

Camada de integração do provedor, consumida pelo servidor e pelos módulos de produto. A autenticação, os IDs e a propriedade da sessão existentes foram preservados. Não há outro login, pool Supabase, player ou agendador local por domínio.

| Entrada | Responsabilidade |
| --- | --- |
| `orquestrador.mjs` | Resolve o provedor/configuração e cria o adaptador existente, incluindo a factory injetada pelos testes. |
| `conector-supabase.mjs` | Adapta autenticação pelo gateway configurado e o attach da biblioteca ao CloudRuntime existente, com deduplicação, orçamento e retry. |
| `conexao/configuracao.mjs` | Configuração de entrada local; hospedagem conserva configuração explícita de ambiente, sem buscar arquivo privado implicitamente. |
| `conexao/autenticacao.mjs` | Endereços aprovados, formulário, identificação do dispositivo e validação da resposta WPLAY nativa. |
| `conexao/provedor-nativo.mjs` | Cliente autenticado e composição dos serviços de domínio; conserva normalização, registro privado de fontes e o kernel VOD único. |
| `conexao/reproducao.mjs` | Intenção/seleção HTTP e composição do transporte web autorizado, com abort, STOP e logout. |
| `ott/` | Contrato RPC web, autenticação, codec/cookies e provedor OTT. |
| [`ao-vivo/`](ao-vivo/README.md) | Catálogo autorizado, grade, jogos, inventário/seleção de fontes e transporte web. |
| [`filmes/`](filmes/README.md) | Catálogo/páginas, metadados e duração limitada do filme selecionado. |
| [`series/`](series/README.md) | Catálogo/páginas, detalhes, temporadas e episódios fornecidos pelo serviço. |
| `vod/` | Catálogos nativo e legado compartilhados; estado e gerações de Filmes/Séries permanecem separados. |

O fluxo de produto permanece em `lib/{tv,filmes,serie}/` e `web/{tv,filmes,serie}/`. O provedor entrega os dados/fontes autorizados; as rotas de produto aplicam seus contratos e a interface apresenta suas projeções. `lib/tv/` não é mais proprietário do transporte específico WPLAY. O player e as rotas de mídia/Range continuam compartilhados.

O Supabase armazena metadados sanitizados e a biblioteca privada. Ele não recebe uma cópia da sessão de mídia nem substitui os servidores WPLAY. O conector usa a configuração existente e mantém credenciais fora dos DTOs públicos. Os cron/leases da coleta central não foram alterados nesta extração.

As APIs de referências temporais de Séries têm módulo próprio em [`lib/serie/marcadores/`](../serie/marcadores/README.md) e conectores na Edge. Duração explícita, duração medida e marcações de abertura/créditos são contratos distintos.

Os arquivos antigos da raiz e as fachadas substituídas foram removidos após migração dos consumidores. Veja a [revisão integrada e seus limites](../../docs/architecture-review-wplay-20261016.md). Testes sintéticos não certificam login, vídeo, estabilidade de fonte ou disponibilidade atuais em produção.
