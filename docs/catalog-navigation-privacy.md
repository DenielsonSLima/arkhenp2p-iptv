# Navegação de categorias e privacidade

Revisão de 15/10/2026. Filmes e Séries usam a ordem **Favoritos, Lançamentos, Todos, demais categorias em ordem alfabética, Adulto**. TV usa Favoritos, Todos, a categoria própria de jogos quando disponível, demais categorias em ordem alfabética e Adulto no final.

## Entrada e estado

- A primeira abertura escolhe Favoritos quando há favoritos visíveis. Sem favoritos, Filmes e Séries abrem Lançamentos; TV abre Todos.
- Uma categoria Lançamentos nativa permitida mantém seus IDs originais, incluindo IDs agrupados. Não é criada uma segunda categoria. Quando ela não existe ou está oculta nas preferências, a visão `__releases` usa a ordem de lançamentos já calculada no Supabase.
- A chegada tardia de favoritos pode concluir a escolha inicial. Depois de uma escolha manual de categoria, gênero, ordenação ou favorito, uma hidratação posterior não altera a categoria aberta. Cada domínio preserva seu estado ao trocar de aba.
- Categorias pessoais antigas continuam editáveis. A opção de criar categorias foi retirada da barra lateral e das configurações; nenhuma coleção existente é excluída pela mudança.

## Conteúdo protegido

Adulto permanece no final da barra, com cadeado, mesmo quando o catálogo protegido não contém seus itens. O clique solicita o PIN da sessão; o servidor mantém o padrão `0000`. Após desbloquear, a categoria escolhida continua aberta durante a recarga do catálogo. Buscar deliberadamente depois do PIN continua permitido. Favoritos adultos escolhidos pelo usuário são preservados e voltam a ficar ocultos ao bloquear a sessão.

Conteúdo adulto não entra em Todos, lançamentos, recomendações automáticas, hero nem histórico. Os módulos de persistência aplicam o contrato descrito em [reprodução adulta sem histórico](adult-playback-privacy.md). A classificação positiva recebida nos detalhes ou em recusa comprovada do banco marca o item atual e invalida apenas o índice correspondente; assim, um índice montado antes dessa classificação não mantém o título na grade normal. Referências antigas também passam pelo bloqueio de PIN antes de abrir detalhes ou player.

Os favoritos legados classificados recebem `isAdult:true` localmente sem serem excluídos. Essa classificação é reaplicada após hidratação da biblioteca, sem gravação remota em cada atualização. IDs classificados em memória pertencem à sessão da conta e são limpos na troca de conexão. Leitores de histórico verificam também o envelope e o episódio, antes da limitação de quantidade.

## Validação interna

- **32 testes direcionados**: navegação, modelo diário de catálogo, configurações de categorias, separação de contas e controle parental.
- Chromium real em contexto isolado, com APIs sintéticas: categoria nativa reaproveitada, fallback SQL, abertura com/sem favoritos, favoritos chegando tarde, seleção manual preservada, categorias nativas ocultas, TV sem Lançamentos, foco no PIN, desbloqueio/rebloqueio, favoritos adultos retidos, histórico legado removido e classificação adulta posterior ao índice. A classificação também permaneceu após bloquear/desbloquear e reconstruir o catálogo; um favorito marcado recebido depois invalidou corretamente a grade já aberta. Nenhuma exceção JavaScript.
- A entrega tardia da biblioteca nessa fixture usa uma adaptação temporária da classe real `CloudAppBridge` para chamar o callback real da aplicação; não afirma validar Realtime remoto. A biblioteca, outbox e Supabase têm testes próprios coordenados na integração.
- A fixture de IndexedDB confirmou que o modelo diário continua sendo enriquecido sem baixar novamente os catálogos nem renovar a idade salva.

Evidências privadas: `.local/verify-navigation-privacy.mjs`, `.local/navigation-privacy-fixture.png` e `.local/verify-read-model-cache.mjs`. Não contêm credenciais e não são parte do produto. Esta verificação exercita comportamento e layout com metadados sintéticos; não certifica transmissão WPLAY nem substitui a validação final da experiência pelo usuário.
