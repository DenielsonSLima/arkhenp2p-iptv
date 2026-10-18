import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CatalogoSeries} from '../lib/serie/catalogo.mjs';
import {MetadadosSeries} from '../lib/serie/metadados.mjs';
import {OrquestradorSeries} from '../lib/serie/orquestrador.mjs';

const categories=[{id:'1',name:'Séries'}],item={kind:'series',id:'100',name:'Série',categoryId:'1'},episodes=[{id:'501',season:1,number:1}],details={...item,seasons:[{number:1,episodes}]};
function fixture(){
  const calls=[],client={
    async catalog(type){calls.push(['catalog',type]);return {categories,items:[item]};},
    async catalogPage(...args){calls.push(['page',...args]);return {categories,items:[item]};},
    invalidateCatalog:type=>calls.push(['invalidate',type]),
    async details(...args){calls.push(['details',...args]);return details;},
  };
  const parental={unlocked:false,items:new Map(),filterCatalog:(data,type)=>{calls.push(['filter',type]);return data;},
    authorize:async(_client,kind,id,value)=>calls.push(['authorize',kind,id,value]),
    rememberCatalog:(data,type)=>calls.push(['remember-parental',type,data]),registerDetails:(...args)=>calls.push(['register',...args])};
  const state={client,parental,authGeneration:1,cloud:null};
  const runtime={fallback:async(_state,kind,identity,load)=>{calls.push(['fallback',kind,identity]);return load(client);},
    catalogReadModel:async()=>null};
  const catalogSearch={remember:(_client,type)=>calls.push(['remember-search',type])};
  return {calls,client,parental,state,runtime,catalogSearch};
}
function routeFixture(f){
  const replies=[],req=Object.assign(new EventEmitter(),{method:'GET',aborted:false}),res=Object.assign(new EventEmitter(),{destroyed:false,
    writeHead(status){replies.push({status});return this;},end(){}});
  const routes=new OrquestradorSeries({cloudRuntime:f.runtime,catalogSearch:f.catalogSearch,respond:(_res,body,status)=>replies.push({body,status})});
  return {req,res,routes,replies,handle:(url)=>routes.handle(req,res,new URL(url,'http://fixture.invalid'),{state:f.state,client:f.client})};
}

test('series route claims only its metadata slices and validates method/ID before provider access',async()=>{
  const f=fixture(),r=routeFixture(f);
  for(const url of ['/api/details?type=movie&id=100','/api/catalog?type=movies','/api/catalog?type=live','/api/play/series/501.mp4','/api/stop'])assert.equal(await r.handle(url),false);
  assert.equal(f.calls.length,0);
  r.req.method='POST';assert.equal(await r.handle('/api/details?type=series&id=100'),true);assert.equal(r.replies.at(-1).status,405);
  r.req.method='GET';await r.handle('/api/details?type=series&id=bad');assert.equal(r.replies.at(-1).status,400);assert.equal(f.calls.length,0);
});

test('series catalogue fallback keeps refresh/category/page, search classification and provider domain isolated',async()=>{
  const f=fixture(),catalog=new CatalogoSeries({cloudRuntime:f.runtime,catalogSearch:f.catalogSearch});
  const result=await catalog.load(f.state,new URLSearchParams('refresh=1&category=1&page=2'));
  assert.deepEqual(result.items,[item]);
  assert.deepEqual(f.calls.slice(0,3),[['invalidate','series'],['fallback','catalog',['series','1',2]],['page','series','1',2]]);
  assert.deepEqual(f.calls.slice(3),[['remember-search','series'],['filter','series']]);
});

test('series shared snapshot attaches only its exact generation/model and forwards page options',async()=>{
  const f=fixture();f.state.cloud={};
  const revision='2026-10-16T20:00:00Z',snapshot={categories,items:[item],pagination:{snapshotId:'generation_A',revisionAt:revision}};
  let model={mediaType:'series',snapshotId:'generation_B',revisionAt:revision,includeAdult:false,total:1},pageOptions;
  f.runtime.catalog=async(_state,type)=>{assert.equal(type,'series');return snapshot;};f.runtime.catalogReadModel=async(_state,type)=>{assert.equal(type,'series');return model;};
  f.runtime.catalogPage=async(_state,type,options)=>{assert.equal(type,'series');pageOptions=options;return snapshot;};
  const catalog=new CatalogoSeries({cloudRuntime:f.runtime,catalogSearch:f.catalogSearch});
  assert.equal((await catalog.load(f.state,new URLSearchParams())).readModel,undefined);
  model={...model,snapshotId:'generation_A'};assert.equal((await catalog.load(f.state,new URLSearchParams())).readModel,model);
  await catalog.load(f.state,new URLSearchParams('paged=1&category=1&page=2&cursor=120&snapshot=generation_A&cache=reload'));
  assert.deepEqual(pageOptions,{category:'1',page:2,cursor:120,snapshotId:'generation_A',includeAdult:false,fresh:true});
});

test('selected series details preserve provider episode IDs and never probe a duration from the first episode',async()=>{
  const f=fixture(),reader=new MetadadosSeries();const result=await reader.read(f.state,'100');
  assert.equal(result,details);assert.equal(result.seasons[0].episodes[0].id,'501');
  assert.equal(f.calls[0][0],'details');assert.equal(f.calls[0][1],'series');assert.equal(f.calls[0][2],'100');assert.equal(f.calls[0][3].probeDuration,false);
  assert.equal(f.calls.some(value=>value[0]==='catalog'),false);assert.equal(f.calls[1][0],'authorize');
});

test('series artwork path uses targeted native classification and returns only the public artwork fields',async()=>{
  const f=fixture();f.client.artworkMetadata=async(kind,id)=>{f.calls.push(['artwork',kind,id]);return {...details,poster:'/api/image?ref=fixture',privateField:'must-not-be-returned'};};
  f.client.nativeVOD={registered:true,snapshot:type=>{assert.equal(type,'series');return {categories};}};
  const result=await new MetadadosSeries().read(f.state,'100',{artworkOnly:true});
  assert.deepEqual(Object.keys(result).sort(),['id','kind','name','poster']);assert.equal(result.privateField,undefined);assert.equal(result.seasons,undefined);
  assert.deepEqual(f.calls.map(value=>value[0]),['artwork','remember-parental','register','authorize']);
});

test('late series catalogue responses cannot commit to another account generation',async()=>{
  const f=fixture(),r=routeFixture(f);let finish;
  f.client.catalog=()=>new Promise(resolve=>{finish=resolve;});
  const pending=r.handle('/api/catalog?type=series');await Promise.resolve();f.state.authGeneration++;
  finish({categories,items:[item]});assert.equal(await pending,true);assert.equal(r.replies.at(-1).status,401);
  assert.equal(f.calls.some(value=>value[0]==='remember-search'||value[0]==='filter'),false);
  assert.equal(r.req.listenerCount('aborted'),0);assert.equal(r.res.listenerCount('close'),0);
});

test('late series detail responses are discarded after PIN change or request cancellation',async()=>{
  for(const mode of ['pin','abort']){
    const f=fixture(),r=routeFixture(f);let finish;
    f.client.details=()=>new Promise(resolve=>{finish=resolve;});
    const pending=r.handle('/api/details?type=series&id=100');await Promise.resolve();
    if(mode==='pin')f.parental.unlocked=true;else{r.req.aborted=true;r.req.emit('aborted');}
    finish(details);assert.equal(await pending,true);
    if(mode==='pin')assert.equal(r.replies.at(-1).status,409);else assert.equal(r.replies.length,0);
    assert.equal(f.calls.some(value=>value[0]==='authorize'),false);
  }
});

test('parental denial remains a denial and does not open an episode or fallback into a different domain',async()=>{
  const f=fixture(),r=routeFixture(f),denial=Object.assign(new Error('Protected'),{status:403,code:'PARENTAL_LOCKED'});
  f.parental.authorize=async()=>{throw denial;};
  await assert.rejects(r.handle('/api/details?type=series&id=100'),error=>error===denial);
  assert.equal(r.replies.length,0);assert.equal(f.calls.every(value=>value[0]==='details'),true);
});
