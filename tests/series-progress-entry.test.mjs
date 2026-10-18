import test from 'node:test';
import assert from 'node:assert/strict';
import {seriesProgressEntry} from '../web/serie/progresso.js';

const item={kind:'series',id:'10',name:'Série',libraryId:'account-a'};
const episode={id:101,title:'Episódio fornecido',number:1,season:2,container:'mp4'};
const video={currentTime:135.25,duration:1800,ended:false};
const options=()=>({item,episode,video,accountLibraryId:'account-a',serializeItem:value=>({...value}),now:12345});

test('series progress serializes only the exact active episode and keeps the existing history DTO',()=>{
  const input=options(),before=structuredClone({item,episode,video});
  assert.deepEqual(seriesProgressEntry(input),{item:{...item},time:135.25,duration:1800,
    episode:{...episode,id:'101'},completed:false,updated:12345,libraryId:'account-a'});
  assert.deepEqual({item,episode,video},before);
  assert.equal(seriesProgressEntry({...input,completed:true}).completed,true);
  assert.equal(seriesProgressEntry({...input,video:{...video,ended:true,duration:Infinity}}).duration,0);
  assert.equal(seriesProgressEntry({...input,video:{...video,ended:true}}).completed,true);
});

test('series progress cannot persist another account or a serializer with another title identity',()=>{
  for(const accountLibraryId of [null,'','other-account'])assert.equal(seriesProgressEntry({...options(),accountLibraryId}),null);
  assert.equal(seriesProgressEntry({...options(),episode:{...episode,libraryId:'other-account'}}),null);
  for(const saved of [{...item,libraryId:'other-account'},{...item,id:'20'},{...item,kind:'movie'},null]){
    assert.equal(seriesProgressEntry({...options(),serializeItem:()=>saved}),null);
  }
  assert.equal(seriesProgressEntry({...options(),serializeItem:()=>{throw new Error('serializer unavailable');}}),null);
});

test('adult classification remains a veto before and after series snapshot serialization',()=>{
  assert.equal(seriesProgressEntry({...options(),item:{...item,isAdult:true}}),null);
  assert.equal(seriesProgressEntry({...options(),episode:{...episode,adult:true}}),null);
  assert.equal(seriesProgressEntry({...options(),item:{...item,categoryId:'restricted'},categories:[{id:'restricted',name:'Reservado',isAdult:true}]}),null);
  assert.equal(seriesProgressEntry({...options(),serializeItem:()=>({...item,isAdult:true})}),null);
  assert.equal(seriesProgressEntry({...options(),canRemember:()=>false}),null);
  assert.equal(seriesProgressEntry({...options(),canRemember:()=>{throw new Error('classification unavailable');}}),null);
});

test('malformed series, episode and playback positions never create a history entry',()=>{
  assert.equal(seriesProgressEntry({...options(),item:{...item,kind:'movie'}}),null);
  assert.equal(seriesProgressEntry({...options(),episode:null}),null);
  assert.equal(seriesProgressEntry({...options(),episode:{id:''}}),null);
  for(const currentTime of [-1,NaN,Infinity,'100',null])assert.equal(seriesProgressEntry({...options(),video:{...video,currentTime}}),null);
  for(const now of [-1,NaN,Infinity])assert.equal(seriesProgressEntry({...options(),now}),null);
  assert.equal(seriesProgressEntry({...options(),video:{...video,currentTime:0}}).time,0);
});
