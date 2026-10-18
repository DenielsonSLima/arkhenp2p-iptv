# Isolamento e retenção das sugestões no frontend

Data: 17/10/2026. Evidência: reprodução sintética antes da correção e testes de regressão após ela. Esta frente não executou navegador, requisição privada, migration ou reprodução audiovisual.

As sugestões de um filme usam `web/filmes/recomendacoes/`: contrato, escopo, modelo TanStack, sessão do destino e apresentação. `web/filmes/tanstack-query.js` conserva a interface anterior como fachada. O modelo de recomendações não possui dependências de TV/EPG nem da projeção privada da Home.

Foram reproduzidas quatro falhas de ciclo de vida:

1. A sessão visual comparava o objeto completo de preferências, embora o modelo de Filmes já filtrasse o escopo. Alterar ocultações de TV ou Séries durante a resposta fazia as sugestões do filme desaparecerem. O destino agora usa somente o escopo de Filmes e a geração da conexão.
2. Ao navegar entre filmes e voltar ao primeiro, uma revalidação 503 começava com a apresentação vazia apesar de existir um resultado válido no cache TanStack. `peek` recupera somente o DTO da RPC, para o mesmo filme, conta, conexão, projeto, provedor, partição e filtros. O destino o mantém durante carregamento e erro; a tentativa seguinte atualiza os cards. Não existe outro armazenamento de sugestões, ranking local ou persistência adicional.
3. A recuperação por conexão podia conservar cards entre provedores diferentes porque sua guarda ignorava o vínculo cloud. Uma mudança de vínculo conhecido ou geração não pode reutilizar a apresentação; apenas preencher um vínculo antes ausente é compatível com a mesma conta e filtros.
4. Se o bootstrap anexasse o vínculo cloud durante a requisição, a resposta antiga era descartada junto com o destino. Agora permanece um estado explícito de erro com nova tentativa, sem resultado vazio artificial nem carregamento indefinido.

A faixa “Recomendados para você” da Home também deixou de substituir uma projeção indisponível por títulos do banner/catálogo. Ela conserva os dados válidos de sua RPC ou usa o aviso de indisponibilidade. A ausência de títulos em uma resposta válida continua distinta de uma falha de transporte.

Validação local: 27 testes em `movie-suggestions.test.mjs`, `movie-recommendations-model.test.mjs`, `home-cloud-sections.test.mjs` e `home-recommendations-state.test.mjs`. Incluem TanStack real integrado à sessão, navegação A→B→A, 503 seguido de retry, separação de conta/provedor/filtros, resposta atrasada e preferências de TV/Séries. As verificações de sintaxe e diff também passaram.

Essas correções impedem que a apresentação agrave ou esconda uma falha remota. Elas não demonstram a causa do HTTP503 no servidor nem certificam a disponibilidade atual do Supabase; essas etapas têm evidência própria.
