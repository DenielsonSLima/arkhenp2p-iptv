# Recuperação por etapas — 15/10/2026

Continuação da base962eef0. Relatos de TV, Início, busca, capas, sugestões e
VOD pertencem à mesma tarefa. Capturas demonstram a falha, mas não identificam
sozinhas qual serviço causou cada HTTP502.

## 1. Transporte

Logs locais confirmaram centenas de erros de filme com status502 e
upstreamStatus429. O proxy preservava429 apenas para TV. Isso comprova
limitação da origem naquele caso; não explica automaticamente todo erro da TV.

`media-request-backoff.mjs` aplica Retry-After por cliente/origem. Range e polls
durante a pausa não voltam à origem nem renovam o prazo. A tentativa também é
estável no VOD; pedidos simultâneos não criam gerações concorrentes. O proxy
conserva401/403,429 e416/Content-Range. O diagnóstico não contém URLs privadas.

O player nativo remove src após erro terminal para cessar probes automáticos;
guarda posição antes de remover a fonte. Consulta o diagnóstico local com
guarda de conta/tentativa e impede novas fontes diante de429, autorização ou
falha estrutural. O flip nativo/HLS conserva o orçamento de troca de fontes.

## 2. Qualidade da TV

`/api/live/sources` entrega descritores sem URLs; SourceId conserva a identidade
do canal/favorito. Auto escolhe a maior qualidade declarada compatível, com até
duas descidas de fonte por abertura. HLS inicia pelo maior índice real
compatível e mantém ABR; manual conserva a escolha. Ver
[contrato de qualidade](tv-quality-source-contract.md).

Nome4K, declaração do provedor e dimensões decodificadas são informações
distintas. Não houve medição de4K nem de abertura inferior a cinco segundos.
TVBus, TVCarS e HTTP continuam protocolos diferentes.

## 3. Grade global

A leitura administrativa confirmou EPG300s e limite que impedia6h; o coletor
reconsultava a origem nas retomadas e publicava lotes parciais. O frontend
tinha fila por cartão com concorrência2.

A migration **20261016022551** foi confirmada no projeto autorizado: intervalo
21600s, staging selado, publicação atômica e registry compacto com RLS. SQL
calcula janela, horários, progresso e próximo boundary. TVGuideClient fornece
uma consulta para cards/canal atual/vizinhos, invalidada pelo registry Realtime.

**Publicação Edge concluída em 16/10:** a credencial CI autorizada resolveu a
recusa anterior. `arkhen-backend` e `arkhen-catalog-sync` foram confirmadas
`ACTIVE`, versão9, às03:03:46 UTC. O readback anterior da migration registrou
760 canais legados, sem primeira captura nova comprovada. Fonte cifrada é
requisito do coletor Edge; não é requisito da RPC de serviço direta ou do worker
local autenticado. Deploy não certifica coleta nem reprodução.
[Estado remoto e corte](tv-guide-global.md).

Enquanto a RPC da Edge estiver indisponível, `tv-guide-compat.mjs` lê os caches
Supabase existentes em lote, compartilhado por partição por até6h. A projeção
de janela/relógio/progresso fica no backend, nunca no navegador; o retorno é
explicitamente legado, parcial e stale. Canal sem linha não apaga os demais.
Essa compatibilidade não consulta WPLAY nem substitui o deploy do coletor.

## 4. Início e biblioteca

Entrada libera no primeiro catálogo útil ou após1,5s; capas têm tarefa própria.
Imagens compartilhadas estáveis sobrevivem à biblioteca, podem servir cache
local antes do upload e recuperam falhas com limites/backoff/guarda de conta.
Busca pode usar snapshot autorizado já carregado e marca cobertura parcial.
Sugestões usam dados centrais ou catálogo carregado, sem alegar personalização
na alternativa. Home preserva o último sucesso.

RPC de organização/Home/sugestões tem orçamento3s e não inicia reautenticação
bloqueante na leitura. CloudLibrary conserva um cliente Auth por projeto/usuário,
preserva refresh token rotacionado e revoga sessão no logout explícito.

## Conferência e manutenção

Skills arkhen-memory-rag e arkhen-senior-engineering instaladas; docs/memory e
retrieve-memory.mjs guardam decisões por domínio sem credenciais/dados pessoais.
Conferência: revisão cruzada, sintaxe dos módulos e compilação da interface.
Sem testes automatizados, navegador ou reprodução; os testes de uso são do usuário.
Código local, migration aplicada, Edge publicada e reprodução comprovada são
estados distintos. Documentos anteriores descrevem etapas históricas.

Ativação: servidor reiniciado em localhost:4173, preservando engine original,
endpoint27043 e mídia8904. Conferência HTTP da página inicial sem login/mídia;
sessões locais anteriores precisam entrar novamente. Nenhum emulador foi iniciado.
53 módulos JavaScript passaram por sintaxe; grafo da interface compilou.


## Etapa seguinte: TV modularizada em 16/10

A integração efetiva está em `web/tv/orquestrador.js` e `lib/tv/orquestrador.mjs`.
Veja o [mapa de manutenção](tv-modularization-20261016.md). Foram extraídas
implementações de programação, lista, favoritos, fontes/resoluções, buffer,
áudio, legendas, agenda e logos. Imports antigos permanecem por fachadas.

A revisão cruzada corrigiu adesão a consulta já cancelada, perda de filtros
na normalização dupla do escopo, override que ocultava remoção remota e
invalidação de EPG por gravação privada. Realtime relê a publicação com
`revalidate`, sem solicitar nova coleta; o cache diário local não encerra essa
releitura antecipadamente. Alterar perfil live agora aplica a configuração live.

Conferência estática: 88 módulos com sintaxe válida; compilação do grafo web
com107 entradas internas e do servidor com49. Sem testes automatizados,
navegador, login ou reprodução. Servidor reiniciado emlocalhost:4173 e página
inicial respondeu HTTP200. Sincronização entre aparelhos e nova coleta EPG
continuam sem comprovação funcional; o usuário fará os testes de uso.

O componente JADX ausente foi obtido de fonte oficial e conferido pelo hash doREA. A inspeção atual confirmou modelos de fontes/EPG; os métodos centrais inspecionados são nativos/protegidos. Isso não certifica a política interna de qualidade ou reprodução doAPK. Evidências no [relatório TV](tv-backend-modules-20261016.md).
