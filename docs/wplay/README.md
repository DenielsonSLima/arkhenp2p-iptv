# Como funciona a integração WPLAY

Revisão estática: 16/10/2026. Esta pasta distingue o APK Android, o player web oficial e as decisões do ARKHEN. Não contém contas, cookies, tokens, URLs privadas de mídia ou capturas de biblioteca pessoal.

O caminho web parte do [player oficial](https://player.wplayott.com/auth): autenticação autorizada, catálogo entregue pelo serviço, endereço de reprodução recebido e decodificação no navegador. A evidência atual identifica HLS.js e HLS nativo; não demonstra necessidade de Android, emulador ou ponte P2P local para esse caminho.

| Documento | Conteúdo |
| --- | --- |
| [Autenticação](autenticacao.md) | Contratos distintos do APK e do site; sessão e isolamento |
| [Catálogo](catalogo.md) | IDs, categorias, capas, episódios e fontes reais |
| [Reprodução](reproducao.md) | Motor web, TV/VOD, STOP, gerações e HTTP 429 |
| [Evidências](evidencias.md) | Hashes, Evidence IDs, localizações e lacunas |
| [EPG no APK](epg-apk-20261016.md) | Grade geral, associação por ID, caches, temporizador e limites estáticos |

A [estratégia EPG do ARKHEN](../epg-architecture-cleanup-20261016.md) distingue esse contrato do fornecedor da publicação Supabase, RPC e consulta compartilhada da interface.

## Limites entre os componentes

1. **WPLAY:** autoriza a conta e entrega seus metadados/fontes. Servidores e endereços são os do contrato autorizado; não se inventa uma conversão de TVBus em HTTP.
2. **ARKHEN:** apresenta a interface, conserva IDs da biblioteca, aplica filtros e coordena uma reprodução ativa. O backend protege a sessão e encaminha somente fontes autorizadas.
3. **Supabase do ARKHEN:** mantém biblioteca pessoal, preferências, progresso, estatísticas e projeções por RPC. Um problema nessa sincronização deve ser apresentado separadamente da disponibilidade do transporte WPLAY; o banco não se torna a engine de mídia.

Autenticação própria do site oficial e biblioteca do ARKHEN têm proprietários diferentes. O uso de um SDK de Auth pelo site não autoriza trocar o projeto Supabase do ARKHEN ou reutilizar dados de outra conta.

## Situação da prova

**Fato observado em bytes:** assets públicos do site foram baixados por HTTP, sem login, e analisados como texto/AST pelo REA. O APK existente teve seu hash reconferido e os resultados estáticos anteriores do mesmo artefato foram recuperados.

**Inferência de integração:** reproduzir os contratos HTTP e as políticas web observadas é o caminho apropriado para o ARKHEN web. O código fonte do servidor oficial não foi fornecido; o JavaScript público mostra seus consumidores, não toda a implementação remota.

**Lacuna:** esta revisão não executou login, canal, filme, episódio, navegador, runtime Android ou teste visual. Não certifica disponibilidade, qualidade ou estabilidade de uma fonte atual.

Os relatórios antigos [do APK e player](../wplay-playback-contract.md) e [da recuperação de TV](../tv-home-recovery-20261015.md) conservam contexto histórico. Seus trechos sobre uma ponte nativa experimental não definem o caminho web atual solicitado pelo usuário.
