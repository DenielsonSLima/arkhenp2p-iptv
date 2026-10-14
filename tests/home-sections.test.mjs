import test from 'node:test';
import assert from 'node:assert/strict';
import {featuredMovies, latestReleases, homeShelves, playbackProgress} from '../web/home-sections.js';
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
