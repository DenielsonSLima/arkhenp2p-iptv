# Alternativas para detectar aberturas na edição realmente reproduzida

Pesquisa pública em 15/10/2026. Nenhum pedido à WPLAY, instalação ou alteração do produto foi realizado nesta pesquisa. As propostas abaixo ainda precisam de ensaio com a edição fornecida pelo provedor.

## Resultado

A alternativa mais adequada para corrigir diferenças de corte é analisar a mídia correspondente e guardar o resultado por edição. Trocar uma base de timestamps por outra não comprova alinhamento. O Intro Skipper é uma implementação aberta que merece um piloto; IntroHater agrega referências, mas não demonstrou resolver esse alinhamento automaticamente.

## Opções verificadas

| Opção | O que oferece | Acesso e custo | Adequação |
| --- | --- | --- | --- |
| Intro Skipper + Jellyfin | Detecção de segmentos no áudio/vídeo e capítulos dos arquivos | Código aberto; servidor, CPU, tráfego e armazenamento próprios | Bom candidato para calcular aberturas por temporada/edição |
| Capítulos da própria mídia | Intervalos já associados ao arquivo, quando nomeados adequadamente | Leitura de metadados com FFprobe; custo de acesso ao arquivo | Primeiro método a testar; capítulos genéricos não provam abertura |
| Chromaprint em worker próprio | Impressões digitais para comparar áudio quase idêntico | Biblioteca aberta + FFmpeg; integração e processamento próprios | Permite localizar um trecho recorrente em diferentes episódios |
| IntroHater | Addon Stremio: base comunitária, AniSkip e capítulos | Código aberto; hospedagem própria, Node, MongoDB, FFmpeg; fluxo descrito usa debrid | Referência de integração; não é garantia de timestamps da edição WPLAY |

O README atual do [Intro Skipper](https://github.com/intro-skipper/intro-skipper) exige Jellyfin 12.0.0+ e jellyfin-ffmpeg 7.1.3-1+. Trata-se de um plugin de servidor, não de uma API pública gratuita com todas as edições já verificadas. Não confirmei nesta pesquisa suporte direto ao fluxo autenticado da WPLAY; isso exige um adaptador e ensaio próprios.

O projeto compara áudio entre episódios, permite reanalisar uma temporada quando novos episódios chegam e reutiliza impressões digitais já calculadas. Isso combina com preparação global, sem trabalho repetido em cada TV. [Configurações gerais oficiais](https://github.com/intro-skipper/intro-skipper/wiki/Settings-%E2%80%90-General).

A janela inicial padrão é limitada por duração e minutos, e há limites para tamanho dos segmentos. Portanto, uma abertura longa ou tardia pode exigir ajuste por temporada. Um tempo final de 3:18 não significa, sozinho, que a abertura dura 198 segundos: início e fim precisam ser medidos separadamente. [Configurações de análise](https://github.com/intro-skipper/intro-skipper/wiki/Settings-%E2%80%90-Analysis).

O processamento tem controles de concorrência, threads e timeout. A documentação atual define duas temporadas simultâneas por padrão, com episódios sequenciais dentro de cada temporada. Maior concorrência aumenta CPU e memória. Não há justificativa para executar essa análise no cliente. [Configurações de desempenho](https://github.com/intro-skipper/intro-skipper/wiki/Settings-%E2%80%90-Performance).

[Chromaprint](https://github.com/acoustid/chromaprint) identifica áudio quase idêntico e não é um detector semântico de abertura. Uma música repetida numa cena pode produzir uma correspondência que ainda exige delimitação e revisão. Minha inferência: usar fingerprints para localizar candidatos, com confirmação dos limites, é mais defensável do que converter duração semelhante em confiança temporal.

O [IntroHater](https://github.com/introhaterapp/IntroHater) documenta a sequência Community DB → AniSkip → capítulos e um proxy HLS que remove trechos do manifesto. O README declara licença MIT e dependências Node/MongoDB/FFmpeg. Essa abordagem não demonstra que a referência comunitária foi comparada ao áudio da edição fornecida. Não recomendo adotar a remoção de segmentos HLS enquanto o intervalo não estiver confirmado; ela tornaria um erro de marcação ainda menos recuperável.

## Filmes e os títulos em teste

O Intro Skipper documenta análise de filmes, incluindo capítulos e detecção visual de créditos. Um filme isolado não oferece, sozinho, outro arquivo com o mesmo áudio recorrente para comparação. Silêncio e quadros pretos ajudam a delimitar candidatos, mas não identificam infalivelmente o começo dos créditos ou uma abertura. [Filmes e tipos de segmento](https://github.com/intro-skipper/intro-skipper/wiki/Movies-and-Segment-Types).

Proposta para o piloto:

1. **Game of Thrones, Vikings e Os Anéis de Poder:** separar temporadas, faixas de áudio e edições; comparar alguns episódios da mesma temporada; revisar episódios de estreia e segmentos diferentes do padrão.
2. **Vikings: Valhalla:** identidade própria; não herdar marcadores de Vikings.
3. **One Piece:** separar anime de 1999 e série de 2023 e confirmar a numeração de episódios antes da análise.
4. **Trilogia O Senhor dos Anéis:** cada filme, corte de cinema/estendido e eventual parte de arquivo são edições distintas. Priorizar capítulos e análise de créditos no próprio arquivo; não calcular uma média entre filmes.

Essas são recomendações de implementação, não resultados de análise audiovisual já executada. Nenhuma fonte consultada comprovou timestamps corretos para os arquivos WPLAY em questão.

## Arquitetura proposta para o ARKHEN

Manter no Supabase as identidades, fila, revisões, resultados e consultas dos clientes. Executar FFmpeg e comparação de áudio em um worker de servidor separado, com concorrência baixa e orçamento por tarefa. Os limites documentados de Edge Functions hospedadas — 256 MB de memória e dois segundos de CPU por pedido — tornam esse ambiente inadequado para assumir uma análise audiovisual pesada. [Limites oficiais do Supabase](https://supabase.com/docs/guides/functions/limits).

Fluxo sugerido, ainda não implementado:

1. Resolver obra, temporada, episódio e edição sem ambiguidades.
2. Inspecionar capítulos e características da mídia autorizada. Quando possível, ler somente trechos necessários; a possibilidade de seek/ranges deve ser medida no provedor, não presumida.
3. Calcular fingerprints de áudio e localizar recorrências; usar análise visual apenas onde trouxer evidência adicional.
4. Guardar candidato com método, versão do detector, faixa de áudio, limites e prova de vínculo com a edição. Uma URL temporária ou a duração total não é essa prova.
5. Conferir amostras do lote inicial e os casos divergentes. Publicar apenas resultados aprovados de forma atômica.
6. Reutilizar o resultado global para todos que receberem a mesma edição. Reprocessar quando a mídia ou o detector mudar. Falhas mantêm o último resultado válido e não criam saltos aproximados.

O Jellyfin distingue metadados de segmentos da decisão do cliente sobre como pular. O ARKHEN pode manter essa separação: preparar intervalos no servidor e exibir o botão no player existente, sem obrigar a pessoa a usar a interface Jellyfin. [Media Segments oficiais](https://jellyfin.org/docs/general/server/metadata/media-segments/).

“Software gratuito” não significa processamento e tráfego gratuitos. Ainda falta medir bytes lidos, CPU por episódio, limites de conexões e precisão nas edições reais. A pesquisa recomenda esse piloto; não promete detecção perfeita nem confirma integração pronta com a WPLAY.
