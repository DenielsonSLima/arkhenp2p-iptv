# Sugestões na prévia e ao terminar um filme

A prévia apresenta até três filmes tanto no primeiro acesso quanto em **Continuar assistindo**. A seleção vem da consulta privada descrita em [recomendações no Supabase](movie-recommendations-rpc.md). A interface conserva a ordem recebida e não percorre o catálogo completo para calcular afinidade.

Ao receber `ended` de um filme realmente concluído, o player guarda a conclusão e apresenta uma tela imersiva com até três sugestões. O encerramento por tempo aproximado ou início presumido dos créditos não abre essa tela. Séries, canais e conteúdo classificado como adulto ficam fora desse fluxo. Não há contagem regressiva nem reprodução automática das sugestões.

Cada sugestão oferece **Assistir** e **Detalhes**. **Rever filme** inicia a mesma obra do zero; **Voltar ao catálogo** retorna a Filmes. O foco inicial permanece em Voltar enquanto as sugestões carregam. Os comandos do player ficam inativos por baixo da tela, Tab permanece dentro das ações e as setas permitem percorrer os botões.

O título da seção distingue afinidade por gênero/categoria, recomendação pelo histórico e alternativa por avaliação: **Filmes semelhantes**, **Recomendados para você** ou **Filmes bem avaliados**. Na tela final, a alternativa por nota recebe a indicação **Bem avaliados no catálogo**. Uma indisponibilidade exibe mensagem e tentativa manual; ela não é apresentada como ausência definitiva de sugestões. Ao atualizar, um resultado anterior compatível permanece visível.

O modelo TanStack compartilha a consulta entre prévia e encerramento, mantendo cancelamento independente por destino. Conta, filtros, revisão da biblioteca, título e classificação adulta são conferidos antes de aplicar respostas e executar ações. Sair da reprodução ou trocar o título descarta o estado visual anterior. A consulta respeita o escopo privado da sessão; não altera o cache diário do catálogo.

## Verificação interna

Em 15/10/2026 passaram 21 testes focados de sessão visual, modelo de consultas, estado da Home e recuperação das prévias. Os casos cobrem resposta de outro título/conta, cancelamento compartilhado, adulto, ordenação recebida, falha sem vazio falso e origem da recomendação.

O fixture `.local/verify-movie-suggestions-browser.mjs` usa o aplicativo real em Chromium isolado, com catálogo, imagens, API e vídeo simulados. Ele conferiu:

- Prévia com progresso salvo e prévia nova exibem três sugestões.
- A posição próxima ao fim não abre a tela; `ended` abre, registra `completed` e não inicia outro filme.
- Foco, Tab, Rever, Detalhes e Assistir funcionam por interação de navegador.
- A alternativa por nota possui título honesto.
- Na Home, indisponibilidade permanece abaixo dos lançamentos de séries; falha HTTP seguida de retry restaura a seção na mesma posição.
- Nenhuma exceção JavaScript ou chamada real à mídia WPLAY ocorreu.

Evidências locais: `.local/movie-suggestions-browser-result.json` e capturas `.local/movie-suggestions-preview.png`, `.local/movie-suggestions-ended.png`, `.local/movie-suggestions-home-offline.png` e `.local/movie-suggestions-home-ready.png`. As imagens identificam a arte de teste.

Esta prova confirma a integração visual e os contratos simulados. Ela não certifica a migração remota, a qualidade das sugestões do catálogo real nem reprodução real WPLAY. O estado da implantação e dos testes de banco está no documento da RPC; a validação final da experiência permanece com o usuário.
