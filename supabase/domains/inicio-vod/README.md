# Início VOD

RPC `public.arkhen_home_vod(text,text,boolean,jsonb,jsonb)`.

Fonte: [migration de isolamento](../../migrations/20261017161601_arkhen_home_vod_isolated.sql), derivada do ranking publicado em `20261016053123`.

A função lê somente as gerações, categorias, favoritos e progresso de Filmes/Séries. Ela preserva a ordenação, exclusões de obras vistas, limites e contagens exatas já contratados. O DTO mantém `schemaVersion: 1` e os campos de compatibilidade `counts.live: 0`, `history.live: []` e `favoriteChannels: []`; os canais são de responsabilidade da RPC TV.

Permissões: `SECURITY INVOKER`, `search_path=''`, execução apenas autenticada, autorização por proprietário e partição e orçamento SQL de oito segundos. Não publica dados privados nem dispara coleta, preparo ou manutenção durante a leitura.

A RPC anterior `arkhen_home_library` permanece disponível para versões antigas do aplicativo. O cliente atual deve chamar a nova RPC. `revisionLibrary` exclui alterações de progresso/favoritos de TV.

Verificação local: `tools/test-home-domain-isolation-fixture.mjs` compara a ordem de recomendações e o histórico com o contrato anterior, depois remove a preparação de TV para demonstrar a independência. Uma migration preparada e testes locais não comprovam publicação ou latência remota.
