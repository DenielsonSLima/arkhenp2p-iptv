import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudHomeSections,cloudFeaturedTitles,readHomeOrder} from '../web/home-cloud-sections.js';
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
test('local favorites/history update immediately while remote recommendations remain bounded and private',()=>{
  const catalogs=fixtures(),favorite={kind:'live',id:'6',name:'Outro canal',savedAt:100},favorites=new Map([['live:6',favorite]]),history=new Map([['movie:1',{item:{kind:'movie',id:'1'},updated:200}]]);
  const sections=cloudHomeSections({catalogs,favorites,history,privateModel:{favoriteChannels:[{kind:'live',id:'4'}],history:{movie:[{kind:'movie',id:'2'}]},recommendations:{items:[{kind:'movie',id:'2'}],personalized:false}},visible:item=>item.id!=='2'});
  assert.deepEqual(sections.find(row=>row.key==='home:live').items.map(item=>item.id),['6']);assert.deepEqual(sections.find(row=>row.key==='home:movie-history').items.map(item=>item.id),['1']);assert.equal(sections.some(row=>row.key==='home:recommendations'),false);
});
test('channel quality variants collapse and absent projection never invents releases',()=>{
  const catalogs=fixtures(),sections=cloudHomeSections({catalogs});assert.deepEqual(sections.find(row=>row.key==='home:live').items.map(item=>item.id),['4','6']);assert.equal(readHomeOrder({itemMap:new Map()},'releases'),null);assert.equal(sections.some(row=>row.key==='home:recommendations'),false);
});
