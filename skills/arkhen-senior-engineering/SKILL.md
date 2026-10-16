---
name: arkhen-senior-engineering
description: Implementar e revisar mudanças do ARKHEN com contratos isolados de Filmes, Séries e TV, investigação por evidências e alterações proporcionais. Use em arquitetura, reprodução, catálogo e biblioteca; não implica publicar, executar mídia ou alterar infraestrutura.
---

# Engenharia do ARKHEN

O pedido do usuário define escopo, autorização e forma de validação. Esta skill não exige commits, testes, navegador ou rituais de aprovação por conta própria.

Recupere primeiro a memória pertinente com `skills/arkhen-memory-rag/SKILL.md`. Confirme contratos nos chamadores e nos arquivos atuais antes de editar; documentação histórica orienta a investigação, mas não certifica o estado de hoje.

Preserve os limites do produto:

- Filmes: detalhes, duração, VOD e sugestões. Não inicializam EPG, jogos ou transporte OTT de TV.
- Séries: temporadas, episódios, próximo episódio, progresso e marcadores da edição. Não inferir duração da série pelo primeiro episódio nem promover referência comunitária a marcador audiovisual confirmado.
- TV: canais, fontes do mesmo canal, EPG, jogos e sessão ao vivo. Uma mudança de grade não reinicia vídeo nem recarrega Filmes/Séries.
- Compartilhado: transporte e caches reutilizáveis, com estado/tarefa por domínio; biblioteca privada permanece por conta. Uma conexão continua tendo somente uma reprodução ativa.

Prefira extrair uma responsabilidade concreta para um módulo com dependências explícitas a criar microserviços, eventos globais ou novas camadas sem necessidade medida. Preserve interfaces externas e as guardas de conta, geração, abort e stop/sid; callbacks antigos não podem reviver uma fonte.

Meça e descreva a fase afetada: autenticação, coleta, publicação, consulta, transferência, renderização ou mídia. Latência de catálogo não mede bitrate do vídeo. Qualidade declarada pelo provedor difere de dimensões medidas; ABR depende das variantes reais da fonte. Não invente HTTP para TVBus/TVCarS nem trate outro canal como variante de qualidade.

Preserve snapshots completos diante de prévia, resposta vazia, revisão antiga e erro. Use lote/deduplicação no caminho de EPG e revisão compacta em Realtime. Dados globais não recebem credenciais, fontes privadas ou progresso. Supabase se restringe ao projeto autorizado no contrato existente; schema/deploy exige a autorização correspondente do pedido.

Faça a menor mudança que resolva a causa observada e revise o diff dentro do ownership combinado. Respeite o modo de validação pedido pelo usuário; quando testes/reprodução estiverem proibidos, relate inspeção ou checagem estática sem apresentá-las como prova funcional. Só declare publicação remota ou reprodução real com evidência dessa operação. Ao concluir, registre decisões duráveis e limites de verificação na memória do domínio.
