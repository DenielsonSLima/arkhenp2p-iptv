import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSeriesStats, allSeriesEpisodes } from '../web/series-preview.js';
import { movieWithPlaybackDuration } from '../web/movie-preview.js';

test('series statistics count all received seasons and episodes without using declared totals or runtime',()=>{
  const data={seasonCount:99,episodeCount:999,duration:'1º episódio: 45 min',seasons:[1,2].map(season=>({number:season,episodes:Array.from({length:8},(_,index)=>({id:String(season*100+index),number:index+1,title:'Episódio'}))}))};
  assert.deepEqual(computeSeriesStats(data),{seasonCount:2,episodeCount:16});assert.equal(allSeriesEpisodes(data).length,16);assert.deepEqual(allSeriesEpisodes(data).map(episode=>episode.season),[...Array(8).fill(1),...Array(8).fill(2)]);
});

test('malformed rows and repeated identities do not inflate the series totals or mutate provider data',()=>{
  const data={seasons:[{number:2,episodes:[{id:'201'},{id:'202'},null,{id:'invalid'}]},{number:'2',episodes:[{id:'201'},{id:'203'}]},{number:0,episodes:[]},{number:'unknown',episodes:[{id:'501'}]},{number:3,episodes:null},null]};
  const before=structuredClone(data);assert.deepEqual(computeSeriesStats(data),{seasonCount:2,episodeCount:3});assert.deepEqual(allSeriesEpisodes(data).map(episode=>episode.id),['201','202','203']);assert.deepEqual(data,before);
  assert.deepEqual(computeSeriesStats({seasonCount:10}),{seasonCount:0,episodeCount:0});assert.deepEqual(computeSeriesStats(null),{seasonCount:0,episodeCount:0});
});

test('movie runtime prefers explicit provider metadata and falls back only to a measured duration',()=>{
  const explicit={id:'1',duration:'1 h 14 min',durationSeconds:4440};assert.equal(movieWithPlaybackDuration(explicit,120).duration,'1 h 14 min');
  assert.equal(movieWithPlaybackDuration({id:'1',duration:''},4440).duration,'1 h 14 min');assert.equal(movieWithPlaybackDuration({id:'1',duration:''},undefined).duration,'');assert.equal(movieWithPlaybackDuration({id:'1',duration:''},NaN).duration,'');
});
