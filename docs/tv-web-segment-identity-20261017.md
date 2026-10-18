# TV web OTT: identidade dos segmentos e investigação real

Data: 17/10/2026. Estado: defeito de contrato reproduzido e corrigido localmente; continuidade audiovisual ainda não certificada. Três frentes trabalharam em transporte, lifecycle do player e revisão independente. O usuário autorizou teste com a própria conta e acesso aos programas. Nenhuma credencial, cookie, URL privada ou hash de mídia pertence a este relatório.

## Evidência anterior à correção

A comparação interna usou uma sessão própria autorizada, uma seleção de canal por vez e STOP/logout ao terminar. Não usou cookies extraídos do navegador. As coletas iniciais observaram playlists; uma coleta adicional comparou até três pares de segmentos completos, limitados a 2 MiB por leitura, sem salvar mídia.

- A fonte escolhida era web OTT, não HTTP nativo nem a engine P2P do APK.
- Nas janelas observadas, MEDIA-SEQUENCE avançou e as respostas foram HTTP 200. Não houve evidência de playlist congelada ou de falha HTTP dos segmentos amostrados.
- Os endereços de todos os segmentos sobrepostos mudavam a cada atualização, embora sequência, discontinuity, duração, origem, caminho, nome do arquivo e URL-base permanecessem iguais. Somente o parâmetro literal `token` mudava.
- Três pares completos, de 353440, 357764 e 376940 bytes, tinham conteúdo idêntico por SHA-256 em memória. Nenhum digest foi registrado. Isto comprova essas amostras, não todos os segmentos futuros.
- A reescrita local incluía a URL assinada completa na identidade HMAC. Assim, cada renovação da autorização também mudava a URI local apresentada ao player.
- TARGETDURATION mudou de 1 para 3 segundos nas coletas. Essa segunda irregularidade permanece observada, sem normalização especulativa.

A [RFC 8216, seções 6.2.1 e 6.3.4](https://www.rfc-editor.org/rfc/rfc8216.html) exige TARGETDURATION constante e recomenda interromper quando o mesmo número de sequência passa a designar outra URI. Logo, a incompatibilidade é concreta; ainda falta demonstrar quanto ela explica das interrupções audiovisuais relatadas.

A descoberta de fontes em sessões frias levou aproximadamente 6,2–13,6 s; o primeiro manifesto levou 1,4–3,8 s nas auditorias internas. São fases separadas. A correção de identidade não elimina essa latência de descoberta e não comprova abertura em 3 s. Não se atribuiu o problema ao Supabase.

## Correção isolada

`lib/tv/web-segment-identity.mjs` mantém uma identidade privada apenas para segmentos EXTINF da seleção web OTT ativa. Exclui somente `token`, literal, único e preenchido, da identidade local. O request upstream continua usando a URL completa autorizada mais recente. Query semântica, sua ordem/encoding, origem, caminho, playlist exata, sequência, discontinuity, duração e época permanecem na identidade.

O registry substitui a entrada do asset, preservando snapshots de requests em voo. A chave do cache backend continua contendo a URL completa: o patch não amplia o reaproveitamento de bytes entre assinaturas. STOP, logout, outra conta, fonte ou tentativa revogam a identidade. Regressão de sequência, mudança de duração e saída/retorno de um contrato incompatível iniciam outra época. Há limites de oito playlists e 256 segmentos por janela.

KEY, MAP, BYTERANGE, variáveis, LL-HLS, VOD, HTTP nativo e OTT direto mantêm o caminho anterior. Não há pré-buffer de outro canal nem alteração de resolução. A guarda após leitura do corpo em `lib/app-server.mjs` rejeita respostas de uma seleção já encerrada antes de publicar assets.

## Verificação e limites

89 testes da implementação/regressões e três testes adicionais de manifesto atrasado passaram. Os últimos simulam STOP, logout e nova tentativa com uma resposta antiga que ignora cancelamento: ela recebe 409 e não reescreve assets. O endpoint sintético confirma que uma URI emitida antes da renovação usa a URL upstream completa atual, preservando os demais parâmetros.

Depois de ativar o código, a coleta real de 30 s teve 12 playlists, sequência de 1 a 14, URIs locais estáveis em todas as sobreposições e nenhuma falha HTTP. As assinaturas originais continuaram mudando; os primeiros agregados contabilizaram 151 mudanças upstream e zero mudanças na URI local. Isso confirma a correção do contrato de playlist, não cinco minutos de vídeo decodificado.

As verificações seguintes selecionaram separadamente HD (rank declarado 720) e SD (480), sem substituição automática. Cada coleta acompanhou 12 s de playlists e leu seis segmentos completos, em série. As 12 leituras tiveram HTTP 200, entre 83 e 323 ms, e todas as sobreposições conservaram a URI local. HD teve seis playlists e janela de 4,004 a 16,016 s; SD teve cinco e janela de 8,008 a 28,028 s. TARGETDURATION permaneceu em 2 s nessas duas amostras. A resolução é declarada pelo provedor, sem confirmação por decodificação. Como as leituras repetidas usavam a mesma rota estável e sua autorização atual, elas não foram apresentadas como nova prova de igualdade entre assinaturas antigas e novas. STOP e logout retornaram 200 ao final de ambas as sessões.

A descoberta demorou 7,154 s em HD e 5,982 s em SD; o primeiro manifesto demorou 1,844 e 2,095 s, respectivamente. A revisão de `inventario-fontes.mjs`, `transporte-web.mjs` e `ott/autenticacao.mjs` identificou catálogo nativo quando necessário, autenticação OTT e catálogo OTT no caminho frio. Não encontrou probe de mídia nessa descoberta nem espera fixa anterior à primeira geração. Sem medir cada subfase, não se pode atribuir os segundos a um endpoint específico. A próxima medição deve aproveitar `Server-Timing: provider, sources` já existente e separar essas subfases antes de otimizar.

O Safari foi testado por UI normal, incluindo o site oficial. O site oficial também apresentou erro nessa sessão; isso não invalida o relato de estabilidade no celular. Na tentativa do ARKHEN, um painel temporário passivo registrou `visibility:hidden`, sem avanço confiável de quadros; depois o controle nativo perdeu a janela (`cgWindowNotFound`). Essa coleta não serve como validação audiovisual. Nenhum ajuste de buffer foi inferido dela.

Xcode estava na tela inicial. Não foi encontrado WPLAY iOS instalado nos simuladores inspecionados, nem simulador iOS iniciado. O APK Android e sua documentação existem; a configuração efetiva de buffer permanece parcialmente protegida por JNI. APK/TVBus/TVCarS e HLS web não são comprovadamente o mesmo caminho de entrega apenas por compartilharem nome do canal e login. Não foi instalada uma nova ponte Android.

Sem migration, publicação remota ou alteração de Home/Filmes/Séries nesta correção. Ainda pendentes: reprodução contínua no Safari visível, comparação audiovisual equivalente nas resoluções disponíveis e redução medida da latência inicial.
