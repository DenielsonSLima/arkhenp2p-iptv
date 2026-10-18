import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {OrquestradorSeries} from '../lib/serie/orquestrador.mjs';
import {OrquestradorFilmes} from '../lib/filmes/orquestrador.mjs';
import {OrquestradorTv,TV_API_PATHS} from '../lib/tv/orquestrador.mjs';

const seriesItem={kind:'series',id:'100',name:'Série fixture',categoryId:'20',poster:'/assets/fixture.svg'};
const adultSeries={kind:'series',id:'101',name:'Série protegida',categoryId:'21'};
const episode={id:'501',title:'Episódio fixture',season:1,number:1,container:'mp4',durationSeconds:1800};
const seriesDetails={...seriesItem,duration:'',durationSeconds:null,seasons:[{number:1,episodes:[episode]}]};
const movieItem={kind:'movie',id:'200',name:'Filme fixture',categoryId:'30'};
const liveItem={kind:'live',id:'300',name:'Canal fixture',categoryId:'40'};
const snapshots={
  series:{categories:[{id:'20',name:'Séries'},{id:'21',name:'Adultos +18'}],items:[seriesItem,adultSeries]},
  movies:{categories:[{id:'30',name:'Filmes'}],items:[movieItem]},
  live:{categories:[{id:'40',name:'Canais'}],items:[liveItem]},
};

async function fixture(t){
  const calls=[],dispatch=[];
  for(const [kind,Controller] of [['series',OrquestradorSeries],['movies',OrquestradorFilmes],['live',OrquestradorTv]]){
    const original=Controller.prototype.handle;
    t.mock.method(Controller.prototype,'handle',function(req,res,url,context){
      if(kind==='live'?TV_API_PATHS.includes(url.pathname):this.handles(url))dispatch.push({kind,path:url.pathname,type:url.searchParams.get('type')});
      return original.call(this,req,res,url,context);
    });
  }
  const app=createApp({connection:{server:'https://fixture.invalid'},cloud:null,providerFactory:({config})=>{
    const client={config,images:new Map(),playbackGeneration:0,
      async connect(){this.authenticatedAt=Date.now();this.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return this.session;},
      async logout(){calls.push(['logout']);this.session=null;},
      async catalog(type){calls.push(['catalog',type]);assert.ok(Object.hasOwn(snapshots,type));return snapshots[type];},
      async catalogPage(type,category,page){calls.push(['catalogPage',type,category,page]);return {...snapshots[type],pagination:{mode:'category',byCategory:{[category]:{loaded:true,nextPage:page+1,hasMore:true}}}};},
      invalidateCatalog:type=>calls.push(['invalidate',type]),
      async details(kind,id,options={}){
        calls.push(['details',kind,id,{probeDuration:options.probeDuration,signal:options.signal instanceof AbortSignal}]);
        if(kind==='series')return id==='100'?seriesDetails:id==='101'?{...adultSeries,seasons:[{number:1,episodes:[{...episode,id:'502'}]}]}:null;
        if(kind==='movie')return {...movieItem,durationSeconds:5400,duration:'1 h30 min'};
        throw new Error('Unexpected details domain');
      },
      async artworkMetadata(kind,id){calls.push(['artwork',kind,id]);assert.equal(kind,'series');return seriesDetails;},
      async liveSources(id){calls.push(['liveSources',id]);return {channelId:id,sources:[{id:'source_fixture',label:'HD',quality:'HD',transport:'hls',available:true}],selectedSourceId:'source_fixture'};},
      async playbackURL(){assert.fail('Metadata integration cannot initiate media');},
      async stopPlayback(){calls.push(['stop']);},
    };
    return client;
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const origin='http://127.0.0.1:'+app.address().port;
  const request=(requestPath,{cookie,body,method=body===undefined?'GET':'POST'}={})=>fetch(origin+requestPath,{method,
    headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=async(username='fixture')=>{
    const response=await request('/api/login',{body:{provider:'xtream',username,password:'fixture-password'}});
    assert.equal(response.status,200);await response.json();return response.headers.get('set-cookie').split(';')[0];
  };
  return {calls,dispatch,request,login};
}

test('createApp dispatches series metadata through its orchestrator and preserves movie/TV contracts without opening media',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/catalog?type=series')).status,401);assert.equal(f.calls.length,0);
  const cookie=await f.login();
  const catalog=await f.request('/api/catalog?type=series',{cookie});assert.equal(catalog.status,200);
  assert.deepEqual(await catalog.json(),{categories:[snapshots.series.categories[0]],items:[seriesItem]});
  const page=await f.request('/api/catalog?type=series&category=20&page=2',{cookie});assert.equal(page.status,200);
  assert.equal((await page.json()).pagination.byCategory['20'].nextPage,3);
  const selected=await f.request('/api/details?type=series&id=100&duration=1',{cookie});assert.equal(selected.status,200);
  const details=await selected.json();assert.deepEqual(details,seriesDetails);
  assert.equal(details.durationSeconds,null);assert.equal(details.seasons[0].episodes[0].id,'501');
  assert.equal(details.seasons[0].episodes[0].durationSeconds,1800);
  assert.deepEqual(f.calls.find(value=>value[0]==='details'&&value[1]==='series'),['details','series','100',{probeDuration:false,signal:true}]);
  const artwork=await f.request('/api/details?type=series&id=100&artwork=1',{cookie});assert.equal(artwork.status,200);
  assert.deepEqual(await artwork.json(),{id:'100',kind:'series',name:'Série fixture',poster:'/assets/fixture.svg'});
  const model=await f.request('/api/catalog/read-model?type=series',{cookie});assert.equal(model.status,503);assert.equal((await model.json()).code,'CATALOG_MODEL_PREPARING');
  const movies=await f.request('/api/catalog?type=movies',{cookie});assert.equal(movies.status,200);assert.deepEqual(await movies.json(),snapshots.movies);
  const film=await f.request('/api/details?type=movie&id=200&duration=1',{cookie});assert.equal(film.status,200);assert.equal((await film.json()).durationSeconds,5400);
  assert.deepEqual(f.calls.find(value=>value[0]==='details'&&value[1]==='movie'),['details','movie','200',{probeDuration:true,signal:true}]);
  const live=await f.request('/api/catalog?type=live',{cookie});assert.equal(live.status,200);assert.deepEqual(await live.json(),snapshots.live);
  const sources=await f.request('/api/live/sources?id=300',{cookie});assert.equal(sources.status,200);
  assert.deepEqual(await sources.json(),{channelId:'300',sources:[{id:'source_fixture',label:'HD',quality:'HD',transport:'hls',available:true}],selectedSourceId:'source_fixture'});
  assert.deepEqual(f.dispatch,[
    {kind:'series',path:'/api/catalog',type:'series'},
    {kind:'series',path:'/api/catalog',type:'series'},
    {kind:'series',path:'/api/details',type:'series'},
    {kind:'series',path:'/api/details',type:'series'},
    {kind:'series',path:'/api/catalog/read-model',type:'series'},
    {kind:'movies',path:'/api/catalog',type:'movies'},
    {kind:'movies',path:'/api/details',type:'movie'},
    {kind:'live',path:'/api/live/sources',type:null},
  ]);
});

test('registered series routes retain parental separation, method/ID guards and logout isolation',async t=>{
  const f=await fixture(t),first=await f.login('first-fixture'),second=await f.login('second-fixture');
  const protectedRequest=await f.request('/api/details?type=series&id=101',{cookie:first});assert.equal(protectedRequest.status,403);assert.equal((await protectedRequest.json()).code,'PARENTAL_LOCKED');
  assert.equal((await f.request('/api/parental/unlock',{cookie:first,body:{pin:'0000'}})).status,200);
  const unlocked=await f.request('/api/details?type=series&id=101',{cookie:first});assert.equal(unlocked.status,200);assert.equal((await unlocked.json()).seasons[0].episodes[0].id,'502');
  assert.equal((await f.request('/api/details?type=series&id=101',{cookie:second})).status,403);
  const before=f.calls.filter(value=>value[0]==='details').length;
  assert.equal((await f.request('/api/details?type=series&id=100',{cookie:first,body:{}})).status,405);
  assert.equal((await f.request('/api/details?type=series&id=bad',{cookie:first})).status,400);
  assert.equal(f.calls.filter(value=>value[0]==='details').length,before);
  const absent=await f.request('/api/details?type=series&id=999',{cookie:first});assert.equal(absent.status,404);
  assert.equal((await f.request('/api/logout',{cookie:first,body:{}})).status,200);
  assert.equal((await f.request('/api/catalog?type=series',{cookie:first})).status,401);
  assert.equal((await f.request('/api/catalog?type=series',{cookie:second})).status,200);
});

test('on-demand markers are authenticated, GET only and cannot fetch before the selected episode plays',async t=>{
  const f=await fixture(t),path='/api/series/episode-markers?imdbId=tt0903747&season=1&episode=1&duration=600&episodeId=501';
  assert.equal((await f.request(path)).status,401);
  const cookie=await f.login();
  assert.equal((await f.request(path,{cookie,body:{}})).status,405);
  assert.equal((await f.request(path.replace('episodeId=501','episodeId=bad'),{cookie})).status,400);
  const inactive=await f.request(path,{cookie});assert.equal(inactive.status,409);
  assert.equal((await inactive.json()).code,'MARKER_PLAYBACK_REQUIRED');assert.equal(f.calls.length,0);
});
