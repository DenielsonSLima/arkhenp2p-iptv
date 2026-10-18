import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudHomeSections} from '../web/inicio/secoes.js';
import {cloudFeaturedTitles} from '../web/inicio/bannerprincipal/selecao.js';
import {homeTVReply} from '../web/inicio/lista-canais/contrato.js';
import {readHomeOrder} from '../web/inicio/projecao.js';
const catalog=(kind,items,orders={})=>{const values=items.map(item=>({...item,kind}));return {items:values,itemMap:new Map(values.map(item=>[item.id,item])),readModel:{orders:{name:values.map(item=>item.id),releases:values.map(item=>item.id),featured:values.map(item=>item.id),...orders}}};};
function fixtures(){return new Map([['movies',catalog('movie',[{id:'1',name:'Zulu',rating:1},{id:'2',name:'Alfa',rating:9}],{releases:['1','2'],featured:['1','2']})],['series',catalog('series',[{id:'3',name:'Serie'}])],['live',catalog('live',[{id:'4',name:'Canal HD'},{id:'5',name:'Canal FHD'},{id:'6',name:'Outro canal'}])]]);}

test('unlocking adult playback never adds adult titles or channels to automatic home sections',()=>{
  const catalogs=fixtures();
  for(const [type,id] of [['movies','1'],['series','3'],['live','4']]){
    const source=catalogs.get(type);source.categories=[{id:'reserved',name:'Reservado',isAdult:true}];source.itemMap.get(id).categoryIds=['reserved'];
  }
  const adultMovie={kind:'movie',id:'1'},adultSeries={kind:'series',id:'3'},adultChannel={kind:'live',id:'4'};
  const safeMovie={kind:'movie',id:'2'},safeChannel={kind:'live',id:'6'};
  const history=new Map([['movie:1',{item:adultMovie,updated:30}],['movie:2',{item:safeMovie,updated:20}],['series:3',{item:adultSeries,updated:40}],['live:4',{item:adultChannel,updated:50}]]);
  const favorites=new Map([['live:4',adultChannel],['live:6',safeChannel]]);
  const privateModel={history:{movie:[adultMovie,safeMovie],series:[adultSeries],live:[adultChannel]},favoriteChannels:[adultChannel,safeChannel],recommendations:{personalized:true,items:[adultMovie,adultSeries,safeMovie]}};
  const sections=cloudHomeSections({catalogs,history,favorites,privateModel,visible:()=>true});
  for(const section of sections)assert.equal(section.items.some(item=>['movie:1','series:3','live:4'].includes(`${item.kind}:${item.id}`)),false,section.key);
  assert.deepEqual(sections.find(section=>section.key==='home:movie-history').items.map(item=>item.id),['2']);
  assert.deepEqual(cloudFeaturedTitles(catalogs,{visible:()=>true}).map(item=>item.id),['2']);
  assert.equal(favorites.size,2,'The home projection does not delete private favorites.');assert.equal(history.size,4,'Persistence reconciliation owns deletion.');
});

test('an adult flag in a previous snapshot cannot be erased by resolving to unmarked metadata',()=>{
  const catalogs=fixtures(),adult={kind:'movie',id:'1',adult:true};
  const history=new Map([['movie:2',{item:{kind:'movie',id:'2'},isAdult:true,updated:20}]]);
  const sections=cloudHomeSections({catalogs,history,privateModel:{history:{movie:[adult]},recommendations:{items:[adult]}}});
  assert.equal(sections.some(section=>section.key==='home:movie-history'||section.key==='home:recommendations'),false);
});
test('home preserves server order, limits lookups and does not sort metadata by local rating',()=>{
  const catalogs=fixtures();let calls=0;assert.deepEqual(readHomeOrder(catalogs.get('movies'),'releases',{limit:1,visible:()=>{calls++;return true;}}).map(item=>item.id),['1']);assert.equal(calls,1);assert.deepEqual(cloudFeaturedTitles(catalogs,{perType:1}).map(item=>item.id),['1','3']);
  const sections=cloudHomeSections({catalogs,privateModel:{recommendations:{personalized:true,items:[{kind:'movie',id:'1'}]},history:{movie:[{kind:'movie',id:'2'}]}}});assert.deepEqual(sections.find(row=>row.key==='home:movie-releases').items.map(item=>item.id),['1','2']);assert.equal(sections.find(row=>row.key==='home:recommendations').title,'Recomendados para você');assert.deepEqual(sections.find(row=>row.key==='home:movie-history').items.map(item=>item.id),['2']);
});
test('local history updates immediately while live selection stays in its dedicated RPC projection',()=>{
  const catalogs=fixtures(),favorite={kind:'live',id:'6',name:'Outro canal',savedAt:100},favorites=new Map([['live:6',favorite]]),history=new Map([['movie:1',{item:{kind:'movie',id:'1'},updated:200}]]);
  const sections=cloudHomeSections({catalogs,favorites,history,privateModel:{favoriteChannels:[{kind:'live',id:'4'}],history:{movie:[{kind:'movie',id:'2'}]},recommendations:{items:[{kind:'movie',id:'2'}],personalized:false}},visible:item=>item.id!=='2'});
  assert.equal(sections.some(row=>row.key==='home:live'),false,'A VOD shelf cannot synthesize channel ranking from local favorites.');assert.deepEqual(sections.find(row=>row.key==='home:movie-history').items.map(item=>item.id),['1']);assert.equal(sections.some(row=>row.key==='home:recommendations'),false);
});
test('missing private projections never invent live or VOD recommendations',()=>{
  const catalogs=fixtures(),sections=cloudHomeSections({catalogs});assert.equal(sections.some(row=>row.key==='home:live'),false);assert.equal(readHomeOrder({itemMap:new Map()},'releases'),null);
  assert.equal(sections.some(row=>row.key==='home:recommendations'),false,'The recommendation failure state is not replaced by unrelated featured titles.');
  const authoritativeEmpty=cloudHomeSections({catalogs,privateModel:{recommendations:{items:[]}}});assert.equal(authoritativeEmpty.some(row=>row.key==='home:recommendations'),false,'A valid empty RPC result suppresses fallback.');
});


test('the dedicated live RPC projection retains its exact most-watched and recent channel order',()=>{
 const reply={schemaVersion:1,source:'rpc',revision:1,generatedAt:'2026-10-16T12:00:00Z',snapshotVersion:'11111111-1111-4111-8111-111111111111',mostWatchedId:'6',items:[
  {item:{id:'6',kind:'live',name:'Outro canal',isAdult:false},reason:'most-watched',watchedSeconds:50,lastWatchedAt:'2026-10-16T10:00:00Z'},
  {item:{id:'5',kind:'live',name:'Canal FHD',isAdult:false},reason:'recent',watchedSeconds:20,lastWatchedAt:'2026-10-16T11:00:00Z'},
  {item:{id:'4',kind:'live',name:'Canal HD',isAdult:false},reason:'recent',watchedSeconds:30,lastWatchedAt:'2026-10-16T11:30:00Z'}]};
 assert.equal(homeTVReply(reply),reply);assert.deepEqual(reply.items.map(entry=>entry.item.id),['6','5','4'],'Metadata variants and local timestamps cannot rerank the RPC result.');
});
