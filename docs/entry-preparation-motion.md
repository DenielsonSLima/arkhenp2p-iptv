# Entrada e preparação da sessão

Atualizado em 15/10/2026.

A preparação em tela cheia usa o mesmo vocabulário visual do carregamento do player: iluminação discreta, brilho no símbolo ARKHEN, entrada suave do texto e indicação das etapas em andamento. O formulário de login recebe uma entrada curta da imagem de fundo, do texto e do cartão, preservando a colagem original.

## Contrato e desempenho

- `SessionLoader.start`, `mark`, `text`, `finish` e o sinal de cancelamento mantêm o contrato anterior. Não foi necessário alterar `app.js`, `index.html` ou o fluxo de autenticação.
- A barra continua baseada exclusivamente nas cinco etapas reais. O movimento sobre ela indica atividade; não altera seu valor nem inventa porcentagens. Etapas parciais continuam contabilizadas como verificadas, sem serem apresentadas como sucesso completo.
- `finish()` oculta a preparação imediatamente. Nenhuma duração mínima, espera artificial, temporizador de progresso ou requisição adicional foi introduzida.
- As decorações são CSS e ficam fora da árvore de acessibilidade. A movimentação da preparação usa principalmente `transform` e `opacity`; o brilho do login atua apenas sobre o pequeno símbolo.
- `prefers-reduced-motion: reduce` remove animações/transições e oculta brilhos móveis. Conteúdo, estados e progresso real permanecem visíveis.
- Em telas baixas na horizontal, marca e etapas ocupam duas colunas para manter todas as etapas visíveis.

## Arquivos

`web/session-loader.js`, `web/session-loader.css` e `web/login-screen.css`.

## Verificação

Os cinco testes existentes de seleção, concorrência, cancelamento e prazo das capas passaram. Uma fixture estática isolada carregou os módulos, HTML, fontes e CSS reais em Chromium, sem consultar APIs, contas ou vídeos.

Foram conferidos os tamanhos 1440×900, 1280×720, 390×844, 844×390 e 320×568, sem corte das etapas nem rolagem horizontal. A fixture também confirmou progresso imóvel sem eventos, estados paralelos, cancelamento ao reiniciar, conclusão imediata, campos de login disponíveis e foco preservado, movimento reduzido e ausência de erros JavaScript. Capturas de tela foram inspecionadas visualmente.

Evidência local: `.local/entry-motion-browser-result.json` e capturas `.local/entry-motion-*.png`. O navegador e o servidor temporários foram encerrados. Essa verificação cobre a apresentação e o ciclo da interface; não mede disponibilidade do WPLAY ou do Supabase.
