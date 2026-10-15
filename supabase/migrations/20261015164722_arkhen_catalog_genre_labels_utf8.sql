-- Windows PowerShell's former string HTTP body replaced non-ASCII SQL literals.
-- Restore only labels and existing compact navigation JSON; no catalog rewrite.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
create or replace function public.arkhen_query_genre_label(p_id text)
returns text language sql immutable parallel safe security invoker set search_path='' as $$
 select label from(values('acao','Ação'),('aventura','Aventura'),('animacao','Animação'),('biografia','Biografia'),('comedia','Comédia'),('crime','Crime'),
 ('documentario','Documentário'),('drama','Drama'),('esporte','Esporte'),('familia','Família'),('fantasia','Fantasia'),('faroeste','Faroeste'),
 ('ficcao-cientifica','Ficção científica'),('guerra','Guerra'),('historia','História'),('infantil','Infantil'),('misterio','Mistério'),('musica','Música'),
 ('musical','Musical'),('novela','Novela'),('policial','Policial'),('reality','Reality'),('romance','Romance'),('suspense','Suspense'),('terror','Terror'),
 ('acao-aventura','Ação e aventura'),('ficcao-fantasia','Ficção e fantasia')) genres(id,label) where id=p_id
$$;
update public.catalog_navigation_cache cache
set payload=jsonb_set(cache.payload,'{genres}',(
 select coalesce(jsonb_agg(genre||jsonb_build_object('name',coalesce(public.arkhen_query_genre_label(genre->>'id'),genre->>'name')) order by public.arkhen_query_title_key(coalesce(public.arkhen_query_genre_label(genre->>'id'),genre->>'name')),genre->>'id'),'[]')
 from jsonb_array_elements(cache.payload->'genres') with ordinality entries(genre,position)
)) where jsonb_typeof(cache.payload->'genres')='array' and exists(
 select 1 from jsonb_array_elements(cache.payload->'genres') genre where public.arkhen_query_genre_label(genre->>'id') is not null and genre->>'name' is distinct from public.arkhen_query_genre_label(genre->>'id')
);
do $$begin
 if public.arkhen_query_genre_label('acao') is distinct from chr(65)||chr(231)||chr(227)||chr(111) then raise exception 'Catalog genre encoding mismatch';end if;
 if exists(select 1 from public.catalog_navigation_cache c cross join lateral jsonb_array_elements(c.payload->'genres') genre where position(chr(65533) in coalesce(genre->>'name',''))>0) then raise exception 'Catalog genre replacement characters remain';end if;
end $$;
commit;
