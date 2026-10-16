# Recomendações de Filmes: ranking versão 2

Data: 16/10/2026. Estado: implementação local e revisão estática; migration não aplicada por esta frente. Não foram executados testes, PostgreSQL local, navegador, catálogo remoto, login ou mídia. O integrador informou uma leitura remota somente leitura: a RPC antiga estava ausente, e os filmes publicados não tinham TMDB/coleção. Essa observação é datada e não foi consultada novamente aqui.

Atualização do integrador: migration aplicada no projeto autorizado em 16/10/2026. A leitura posterior confirmou função invoker com padrão10, execução autenticada/recusa anônima e índice GIN válido/pronto. A classificação agregada do catálogo também foi consultada, sem executar a RPC com JWT de espectador. Evidências e limites estão no [registro integrado](movies-modularization-20261016.md).

## Causa e mudança

A RPC anterior só considerava gênero, categoria, histórico e nota. Limitava 600 IDs sem qualquer associação de franquia/universo. O endpoint aceitava trocar uma falha da RPC pelo ranking do catálogo parcial carregado, sem garantir continuações ou a mesma ordem entre dispositivos.

`20261016042729_arkhen_movie_identity_recommendations.sql` usa `CREATE OR REPLACE` na mesma assinatura `arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb)`; instala a função mesmo quando a migration antiga não foi aplicada, desde que as dependências já existentes estejam presentes. Limite 1–10, padrão 10. Ordem lexicográfica:

1. Mesma franquia reconhecida por aliases editoriais.
2. Mesmo universo editorial DC/Marvel com associação positiva para origem e candidato.
3. Gêneros reconhecidos em comum, valorizando grupos menos frequentes na geração.
4. Categoria específica do provedor, excluindo plataforma, qualidade, grupos gerais e Lançamentos.
5. Afinidade com gêneros do histórico privado.

Nota e posição estável só desempatarão candidatos relacionados. Não há preenchimento global por lançamento/nota quando faltam vínculos. É válido retornar menos de dez. O classificador não usa sinopse, ator, conta ou biblioteca pessoal.

Os campos atuais não carregam uma coleção explícita: TMDB/IMDb identificam obras, não coleções. Não foi inventado `collectionId` nem continuidade MCU/DCU. A [análise de identidade](movies-recommendation-identity-20261016.md) separa obra/coleção/franquia/universo e registra fontes oficiais.

## Identidade e custo limitado

`arkhen_movie_recommendation_keys(name,query_release_year)` é uma função imutável com aliases estáticos versão 1. Usa a limpeza técnica do helper existente e um loop local para ano terminal: `Avatar Fogo e Cinzas -2026` pode corresponder ao alias, sem retirar números de sequências como 2/7/X. Um ano declarado contraditório não é descartado silenciosamente. O loop reaplica os sufixos de qualidade/idioma antes/depois do ano.

Há regras positivas para Batman/DC, Homem-Aranha/Spider-Man/Marvel, Velozes e Furiosos, Transformers e duas famílias Avatar. Outras famílias positivas de DC/Marvel permitem o segundo nível de candidatos. Flash/Venom e certos aliases completos exigem ano. Avatar sem qualificação suficiente fica sem chave; Cameron e Aang são mutuamente excluídos mesmo ao preencher por gênero. Documentários reconhecidos por gênero não recebem vínculo; termos explícitos de bastidores/documentário/paródia no título também não. Não há lookup externo ou afirmação de cobertura completa do catálogo.

O índice GIN parcial `arkhen_movie_recommendation_keys_v1` materializa a expressão para filmes ativos/nãoadultos. Até 600 IDs de vínculo forte entram independentemente dos 600 de afinidade genérica. Toda leitura conserva provedor/escopo/geração. Até 120 candidatos têm metadados lidos para adulto, vistos e dedupe; a resposta tem até dez. A quantidade de edições dentro desses limites pode reduzir o total final; isso não autoriza inventar disponibilidade.

IMDb/TMDB válidos identificam a mesma obra; título/ano é fallback sem unir só por título quando IDs presentes se contradizem. Franquias não são deduplicadas como uma só obra. Não foi acrescentada coluna gerada que reescreva o catálogo. O índice cria custo na publicação; o plano com JWT/RLS e seu uso efetivo não foram medidos. Mudar a função imutável requer versionar/reconstruir o índice.

O desenho usa o suporte oficial de [índices por expressão](https://www.postgresql.org/docs/current/indexes-expressional.html) e [GIN com sobreposição de arrays](https://www.postgresql.org/docs/current/gin.html). Referências editoriais adicionais: [catálogo DC](https://www.dc.com/movies), [guia Marvel](https://www.marvel.com/amp/articles/movies/the-essential-marvel-cinematic-universe-guide-phase-three) e [catálogo Marvel da Disney](https://d23.com/a-to-z/marvel-entertainment/). São agrupamentos editoriais, sem prova de disponibilidade no provedor.

## Segurança, API e rollout

Preservados `SECURITY INVOKER`, `auth.uid()`, RLS, `arkhen_partition_allows`, JWT do usuário, geração visível, adulto/ocultações, histórico do proprietário e exclusão de vistos. O navegador não escolhe provedor/escopo/usuário nem manda classificações. A RPC continua somente leitura, sem login adicional, fila, outro domínio ou chave administrativa. Mantém orçamento de 8s; migration tem lock timeout 5s/statement timeout 30s, sem alteração global.

DTO: `schemaVersion:1`, `generatedAt`, `sourceId`, `revision`, `revisionLibrary`, `personalized` e `items`; novos `source:'rpc'`, `rankingVersion:2`, `identityVersion:1`. `reason` do primeiro item: `source_franchise`, `source_universe`, `source_genre`, `source_category`, `history_genre` ou `unavailable`. Cada item traz `recommendationReason` próprio porque uma lista pode misturar classes.

`ServicosFilmes` não chama mais `SessionMovieRecommendations`. O conector exige a versão nova; RPC ausente/falha/modelo não preparado resulta em `503/MOVIE_RECOMMENDATIONS_UNAVAILABLE`, sem fabricar sucesso vazio. O helper legado permanece fora desse caminho. O cliente conserva somente último DTO compatível com conta, origem, revisão, filtros e rankingVersion, sem ranking local. Aplicar a migration precede a disponibilidade desse contrato.

Fluxo local efetivo: ajuda de `supabase`, `migration`, `migration new`, `db`, `db schema`; depois `supabase migration new arkhen_movie_identity_recommendations`. Nenhum push/up/DDL remoto foi executado por esta frente. A CLI inicialmente não conseguiu escrever telemetria fora do workspace; os comandos locais autorizados foram repetidos com a permissão de filesystem correspondente.

## Consultas de revisão somente leitura, não executadas aqui

Inspeção de schema após a publicação, sem tokens, IDs de conta ou mídia:

```sql
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer, p.provolatile as volatility, p.proconfig as settings,
       pg_catalog.has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
       pg_catalog.has_function_privilege('anon',p.oid,'execute') as anonymous_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in('arkhen_movie_recommendations','arkhen_movie_recommendation_keys');

select c.relname, i.indisready, i.indisvalid
from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='arkhen_movie_recommendation_keys_v1';
```

Modelo de diagnóstico autenticado: placeholders devem vir da própria sessão autorizada, sem publicar valores. Requer JWT normal da conta para aplicar RLS/auth.uid(); não substituir por outra conta ou service role:

```sql
with response as materialized (
  select public.arkhen_movie_recommendations(
    :provider_key, :scope_hash, :source_id, 10,
    :hidden_categories::jsonb, :hidden_items::jsonb
  ) as dto
)
select dto->>'schemaVersion' as schema_version, dto->>'rankingVersion' as ranking_version,
       dto->>'identityVersion' as identity_version, dto->>'source' as source,
       dto->>'reason' as reason, jsonb_array_length(dto->'items') as item_count,
       (select count(distinct item->>'id')
        from jsonb_array_elements(dto->'items') item) as distinct_item_count,
       (select jsonb_agg(item->>'recommendationReason' order by position)
        from jsonb_array_elements(dto->'items') with ordinality entries(item,position)) as ordered_reasons
from response;
```

Inspeção de schema e criação da migration não comprovam ranking remoto, latência, completude ou reprodução. Checagens locais: leitura SQL, `node --check`, bundle esbuild não executado e whitespace. Não havia parser/executor PostgreSQL local instalado; não foi instalado nem iniciado um para esta etapa.
