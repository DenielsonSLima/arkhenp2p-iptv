import test from 'node:test';
import assert from 'node:assert/strict';
import {featuredMovies, featuredTitles, latestReleases, homeShelves, playbackProgress} from '../web/home-sections.js';
const item = (id, name, kind = 'movie', extra = {}) => ({id:String(id), name, kind, ...extra});
test('three banner titles are movies, ordered by supplied release data without fictional dates', () => {
  const entries = [item(1,'Antigo', 'movie',{year:'2020'}),item(2,'Mais recente','movie',{year:'2026'}),item(3,'Série','series',{year:'2027'}),item(4,'Segundo','movie',{year:'2025'}),item(5,'Terceiro (2024)'),item(6,'Sem ano')];
  assert.deepEqual(featuredMovies(entries).map(entry=>entry.id),['2','4','5']);
  assert.deepEqual(featuredMovies([item(7,'Estreia','movie',{group:'Lançamentos',year:'2026'}),...entries],1).map(entry=>entry.id),['7']);
  assert.equal(entries[5].year,undefined);
});
test('home shelves keep requested order, separate histories and exclude hidden or removed titles', () => {
  const movies=[item(1,'Filme'),item(2,'Novo','movie',{year:'2026'})],series=[item(3,'Série','series')],live=[item(4,'Globo Sergipe HD','live'),item(5,'Globo Sergipe SD','live'),item(6,'Globo Bahia HD','live')];
  const favorites=new Map([['live:4',{...live[0],savedAt:10}]]);
  const history=new Map([['movie:1',{item:movies[0],time:100,updated:3}],['series:3',{item:series[0],time:50,updated:4}],['live:5',{item:live[1],updated:5}],['live:6',{item:live[2],updated:6}],['movie:99',{item:item(99,'Oculto'),time:50,updated:20}]]);
  const shelves=homeShelves({movies,series,live,favorites,history});
  assert.deepEqual(shelves.map(section=>section.key),['home:live','home:movie-history','home:movie-releases','home:series-history','home:series-releases']);
  assert.deepEqual(shelves[0].items.map(entry=>entry.id),['4','6']);
  assert.deepEqual(shelves[1].items.map(entry=>entry.id),['1']);
  assert.deepEqual(shelves[3].items.map(entry=>entry.id),['3']);
});
test('new accounts have real catalog shelves and no manufactured watching history', () => {
  const shelves=homeShelves({movies:[item(1,'Filme')],series:[item(2,'Série','series')],live:[item(3,'Canal SD','live'),item(4,'Canal HD','live')]});
  assert.deepEqual(shelves.map(section=>section.key),['home:live','home:movie-releases','home:series-releases']);
  assert.equal(shelves[0].items[0].id,'4');
});
test('progress clamps playback positions, labels the actual episode and handles unknown duration', () => {
  assert.deepEqual(playbackProgress({item:item(1,'Série','series'),time:60,duration:120,episode:{season:2,number:3}}),{percent:50,completed:false,resumable:true,episodeLabel:'T2 · E3'});
  assert.equal(playbackProgress({time:150,duration:100}).percent,100);
  assert.equal(playbackProgress({time:99,duration:100}).resumable,false);
  assert.equal(playbackProgress({time:60,duration:0}).percent,null);
  assert.equal(playbackProgress({time:-5,duration:100}).resumable,false);
});
test('release selection deduplicates quality copies and keeps dated remakes distinct', () => {
  assert.deepEqual(latestReleases([item(1,'Título HD','movie',{year:2026}),item(2,'Título FHD','movie',{year:2026}),item(3,'Título','movie',{year:2000})]).map(entry=>entry.id),['1','3']);
  assert.deepEqual(latestReleases([item(1,'Superman (2025) HD'),item(2,'Superman (2025)')]).map(entry=>entry.id),['1']);
});

test('featured releases prefer usable artwork and supplied ratings within the recent release window', () => {
  const complete = {year:2026,poster:'/api/image?ref=poster',backdrop:'/api/image?ref=backdrop',rating:7.5};
  const result = featuredMovies([item(1,'Somente título','movie',{year:2026}),item(2,'Estreia','movie',complete),item(3,'Outra estreia','movie',complete),item(4,'Clássico','movie',{...complete,year:1999})]);
  assert.deepEqual(result.map(entry=>entry.id),['2','3','1']);
});

test('six home highlights balance three recent movies and three series, alternating types', () => {
  const movies=[item(1,'Filme antigo','movie',{year:2020}),item(2,'Filme recente','movie',{year:2026}),item(3,'Filme dois','movie',{year:2025}),item(4,'Filme três','movie',{year:2024})];
  const series=[item(1,'Série antiga','series',{year:2020}),item(2,'Série recente','series',{year:2026}),item(3,'Série dois','series',{year:2025}),item(4,'Série três','series',{year:2024})];
  const before=structuredClone({movies,series}),featured=featuredTitles(movies,series);
  assert.deepEqual(featured.map(entry=>`${entry.kind}:${entry.id}`),['movie:2','series:2','movie:3','series:3','movie:4','series:4']);
  assert.deepEqual({movies,series},before);
});

test('partial highlight catalogs show only real entries without filling a missing type with extra movies', () => {
  const movies=Array.from({length:8},(_,index)=>item(index,`Filme ${index}`));
  const series=[item('series','Única série','series')];
  const featured=featuredTitles(movies,series);
  assert.equal(featured.length,4);assert.equal(featured.filter(entry=>entry.kind==='movie').length,3);
  assert.equal(featured.filter(entry=>entry.kind==='series').length,1);
  assert.deepEqual(featuredTitles([],[]),[]);
  assert.deepEqual(featuredTitles(movies,series,{perType:0}),[]);
  assert.deepEqual(featuredTitles(movies,series,{perType:1}).map(entry=>entry.kind),['movie','series']);
});

test('mixed highlights preserve artwork preference and deduplicate quality copies separately within each type', () => {
  const ready={year:2026,poster:'/api/image?ref=poster',backdrop:'/api/image?ref=backdrop',rating:8};
  const featured=featuredTitles([
    item('m0','Sem imagem','movie',{year:2026}),item('m1','Novo filme HD','movie',ready),item('m2','Novo filme FHD','movie',ready)
  ],[
    item('s0','Série sem imagem','series',{year:2026}),item('s1','Nova série HD','series',ready),item('s2','Nova série FHD','series',ready)
  ]);
  assert.deepEqual(featured.map(entry=>entry.id),['m1','s1','m0','s0']);
});

test('home prepares up to thirty distinct titles per shelf', () => {
  const movies=Array.from({length:40},(_,index)=>item(index,`Filme ${index}`)),series=Array.from({length:40},(_,index)=>item(index,`Série ${index}`,'series'));
  const sections=homeShelves({movies,series});
  assert.equal(sections.find(section=>section.key==='home:movie-releases').items.length,30);
  assert.equal(sections.find(section=>section.key==='home:series-releases').items.length,30);
  assert.equal(latestReleases(movies).length,30);
});

test('a mixed recommendation shelf follows series and uses actual watched genres', () => {
  const watched=item(1,'Filme assistido','movie',{genre:'Ação',rating:8}),movies=[watched,item(2,'Outro filme','movie',{genre:'Ação',rating:7.5})],series=[item(1,'Nova série','series',{genre:'Ação',rating:8.5})];
  const history=new Map([['movie:1',{item:watched,time:120,updated:1}]]),sections=homeShelves({movies,series,history}),recommendations=sections.at(-1);
  assert.equal(sections.at(-2).key,'home:series-releases');
  assert.equal(recommendations.key,'home:recommendations');
  assert.equal(recommendations.title,'Recomendados para você');
  assert.equal(recommendations.type,'mixed');
  assert.deepEqual(new Set(recommendations.items.map(entry=>entry.kind)),new Set(['movie','series']));
  assert.equal(recommendations.items.includes(watched),false);
});

test('recommendations without viewing signals use an honest highly rated fallback', () => {
  const sections=homeShelves({movies:[item(1,'Bom filme','movie',{rating:8}),item(2,'Sem avaliação')],series:[item(1,'Boa série','series',{rating:9})]});
  assert.equal(sections.at(-1).key,'home:recommendations');
  assert.equal(sections.at(-1).title,'Filmes e séries bem avaliados');
  assert.equal(sections.at(-1).items.length,2);
  assert.equal(homeShelves({movies:[item(1,'Sem avaliação')]}).some(section=>section.key==='home:recommendations'),false);
});
