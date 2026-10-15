import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {MarkerSyncRegistry,markerSyncError,renderMarkerSyncSettings} from '../web/marker-sync-settings.js';
import {SETTINGS_SECTIONS,renderGeneral} from '../web/settings-views.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function snapshot(overrides={}){
  return {schemaVersion:1,generatedAt:'2026-10-15T16:00:00Z',status:'partial',providers:[{id:'skipdb',configured:true,status:'ready',lastCheckedAt:'2026-10-15T15:58:00Z',lastSuccessAt:'2026-10-15T15:58:00Z'},{id:'introdb',configured:false,status:'cooldown',retryAt:'2026-10-15T16:05:00Z'}],global:{series:2000,episodes:40000,introEpisodes:30000,creditsEpisodes:20000,recapEpisodes:5000,unverifiedEpisodes:11},catalog:{series:8124,identifiedSeries:22,pendingSeries:8102,unresolvedSeries:28,failedSeries:0,episodes:66,withMarkers:24},recent:[{id:'cycle-1',occurredAt:'2026-10-15T15:58:00Z',status:'partial',episodesChecked:66,skipdb:8,introdb:24,empty:42,failures:1}],issues:[{title:'Uma série',status:'unresolved',reasonCode:'no_match',updatedAt:'2026-10-15T15:58:00Z'}],...overrides};
}
function registry(t,api){
  let scope={project:'https://project.example',providerKey:'provider-a',scopeHash:'scope-a'};
  const controller=new MarkerSyncRegistry({api,getScope:()=>scope,loadQueryCore:async()=>({QueryClient})});
  t.after(()=>controller.reset());return {controller,setScope:next=>scope=next};
}

test('registry is lazy, deduplicates reads, reuses fresh data and manual refresh performs only GET',async t=>{
  const calls=[],pending=deferred(),f=registry(t,(path,options)=>{calls.push({path,options});return calls.length===1?pending.promise:Promise.resolve(snapshot());});
  assert.equal(calls.length,0);let notifications=0;f.controller.subscribe(()=>notifications++);assert.equal(calls.length,0);
  const first=f.controller.refresh(),second=f.controller.refresh();assert.equal(first,second);await tick();assert.equal(calls.length,1);
  pending.resolve(snapshot());await first;assert.equal(f.controller.state.loading,false);assert.equal(f.controller.state.data.catalog.withMarkers,24);
  await f.controller.refresh();assert.equal(calls.length,1);
  await f.controller.refresh({force:true});assert.equal(calls.length,2);assert.ok(notifications>2);
  assert.ok(calls.every(({path,options})=>path==='/api/markers/sync-status'&&options.method===undefined));
  assert.equal(f.controller.client.getQueryCache().getAll().length,1);
  assert.deepEqual(f.controller.client.getQueryCache().getAll()[0].queryKey,['arkhen-marker-sync','https://project.example','provider-a','scope-a']);
});

test('failed and invalid refresh keep the last valid registry without exposing raw errors',async t=>{
  let mode='ok';const f=registry(t,async()=>{if(mode==='error')throw new Error('https://provider.invalid/?key=secret');if(mode==='invalid')return {schemaVersion:3};return snapshot();});
  await f.controller.refresh();const before=f.controller.state.data;
  mode='error';await f.controller.refresh({force:true});assert.equal(f.controller.state.data,before);assert.match(f.controller.state.error,/Não foi possível/);assert.doesNotMatch(f.controller.state.error,/secret|https/);
  mode='invalid';await f.controller.refresh({force:true});assert.equal(f.controller.state.data,before);assert.equal(f.controller.state.loading,false);
});

test('closing the registry cancels the request and ignores a late response',async t=>{
  const pending=deferred();let signal;const f=registry(t,async(_path,options)=>{signal=options.signal;return pending.promise;});
  const request=f.controller.refresh();await tick();f.controller.pause();assert.equal(signal.aborted,true);assert.equal(f.controller.state.loading,false);
  pending.resolve(snapshot());await request;assert.equal(f.controller.state.data,null);assert.equal(f.controller.state.error,null);
});

test('an account reset fences late results even when the new account uses the same global scope',async t=>{
  const pending=deferred();let reads=0;const f=registry(t,async()=>++reads===1?pending.promise:snapshot({status:'ready'}));
  const old=f.controller.refresh();await tick();f.controller.reset();await f.controller.refresh();pending.resolve(snapshot({status:'failed'}));await old;
  assert.equal(f.controller.state.data.status,'ready');assert.equal(reads,2);
});

test('another catalog scope gets a separate query and never inherits the previous snapshot',async t=>{
  const pending=deferred();let reads=0;const f=registry(t,async()=>++reads===1?snapshot():pending.promise);
  await f.controller.refresh();f.setScope({project:'https://project.example',providerKey:'provider-a',scopeHash:'scope-b'});
  const request=f.controller.refresh();assert.equal(f.controller.state.data,null);await tick();pending.resolve(snapshot({catalog:{series:9}}));await request;
  assert.equal(f.controller.state.data.catalog.series,9);assert.equal(f.controller.client.getQueryCache().getAll().length,1);
});

test('leaving during the lazy SDK import prevents the API read',async t=>{
  const sdk=deferred();let reads=0;const controller=new MarkerSyncRegistry({api:()=>{reads++;return snapshot();},loadQueryCore:()=>sdk.promise});t.after(()=>controller.reset());
  const request=controller.refresh();controller.pause();sdk.resolve({QueryClient});await request;assert.equal(reads,0);
});

test('authentication failures have actionable messages without leaking backend data',()=>{
  assert.match(markerSyncError({status:401,message:'private'}),/Entre novamente/);
  assert.match(markerSyncError({status:403,message:'private'}),/esta conta/);
  assert.doesNotMatch(markerSyncError({status:503,message:'Bearer secret'}),/secret|Bearer/);
});

class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.listeners={};this.scrollLeft=0;this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,handler){this.listeners[key]=handler;}
  querySelector(selector){return walk(this).find(item=>selector.startsWith('.')&&item.className?.split(' ').includes(selector.slice(1)))||null;}
}
function walk(root){return [root,...root.children.flatMap(walk)];}
function text(root){return walk(root).map(item=>item.textContent||'').join(' ');}
function dom(t){
  const previous={document:globalThis.document,window:globalThis.window},scroll=[];
  globalThis.document={createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)};globalThis.window={scrollX:0,scrollY:300,scrollTo:options=>scroll.push(options)};
  t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});return{container:new Element('main'),scroll};
}
function controlledView(t,initial={data:null,loading:false,error:null}){
  const fixture=dom(t),reads=[];let listener,paused=0;
  const controller={subscribe:fn=>{listener=fn;fn(initial);return()=>listener=null;},refresh:options=>{reads.push(options);return Promise.resolve();},pause:()=>paused++};
  const cleanup=renderMarkerSyncSettings(fixture.container,{controller});return{...fixture,reads,update:state=>listener?.(state),cleanup,paused:()=>paused};
}

test('view distinguishes global inventory from catalog coverage and shows provider priority with real timestamps',t=>{
  const f=controlledView(t,{data:snapshot(),loading:false,error:null}),content=text(f.container);
  assert.match(content,/Biblioteca global/);assert.match(content,/40\.000/);assert.match(content,/Cobertura do seu catálogo/);assert.match(content,/8\.124/);assert.match(content,/66 episódios identificados/);
  assert.match(content,/1 · Principal/);assert.match(content,/2 · Alternativa/);assert.match(content,/Acesso público/);assert.match(content,/Quando a consulta falha/);
  assert.match(content,/referência comunitária/);assert.match(content,/Correspondência não encontrada/);assert.doesNotMatch(content,/100%|garantid|secret|lease|SQL/);
  assert.equal(f.reads.length,1);f.cleanup();assert.equal(f.paused(),1);
});

test('loading and errors preserve results, refresh control identity and scroll without redrawing content',t=>{
  const data=snapshot(),f=controlledView(t,{data,loading:false,error:null}),results=f.container.querySelector('.marker-sync-results'),rendered=results.children[0],refresh=walk(f.container).find(item=>item.tagName==='button');
  const initialScrolls=f.scroll.length;f.update({data,loading:true,error:null});assert.equal(results.children[0],rendered);assert.equal(refresh.attributes['aria-disabled'],'true');assert.equal(f.scroll.length,initialScrolls);refresh.listeners.click();assert.equal(f.reads.length,1);
  f.update({data,loading:false,error:'Não foi possível atualizar o registro.'});assert.equal(results.children[0],rendered);assert.equal(refresh.attributes['aria-disabled'],'false');assert.match(text(f.container),/último registro disponível continua abaixo/);assert.equal(f.scroll.length,initialScrolls);
  refresh.listeners.click();assert.deepEqual(f.reads.at(-1),{force:true});
  const history=f.container.querySelector('.marker-sync-history-scroll');history.scrollLeft=125;
  f.update({data:snapshot({status:'ready'}),loading:false,error:null});assert.equal(walk(f.container).find(item=>item.tagName==='button'),refresh);assert.equal(f.container.querySelector('.marker-sync-history-scroll').scrollLeft,125);assert.deepEqual(f.scroll.at(-1),{left:0,top:300,behavior:'instant'});
  f.cleanup();
});

test('the initial failure stays actionable and an empty history never invents successful cycles',t=>{
  const f=controlledView(t,{data:null,loading:true,error:null});assert.match(text(f.container),/Carregando/);
  f.update({data:null,loading:false,error:'Não foi possível atualizar o registro.'});assert.match(text(f.container),/Não foi possível/);assert.equal(walk(f.container).some(item=>item.tagName==='table'),false);
  f.update({data:snapshot({recent:[],issues:[]}),loading:false,error:null});assert.match(text(f.container),/Ainda não há ciclos registrados/);assert.equal(walk(f.container).some(item=>item.tagName==='table'),false);f.cleanup();
});

test('settings exposes the registry as its own section and shortcut',t=>{
  const f=dom(t),opened=[];assert.equal(SETTINGS_SECTIONS.find(item=>item.id==='marker-sync')?.label,'Sincronização de aberturas');
  renderGeneral(f.container,{open:id=>opened.push(id)});const shortcut=walk(f.container).find(item=>item.className==='settings-shortcut'&&text(item).includes('Sincronização de aberturas'));assert.ok(shortcut);shortcut.listeners.click();assert.deepEqual(opened,['marker-sync']);
});

test('recently identified series expose names and safe IMDb identities without treating lookup success as saved markers',t=>{
  const f=controlledView(t,{data:snapshot({identified:[{title:'Série identificada',imdbId:'tt0944947',episodes:3,withMarkers:2,updatedAt:'2026-10-15T16:00:00Z'},{title:'Outra série',imdbId:'https://unsafe/?key=secret',episodes:1,withMarkers:0}]}),loading:false,error:null});
  const content=text(f.container);assert.match(content,/Séries identificadas recentemente/);assert.match(content,/2 episódios com marcações de 3 identificados · IMDb tt0944947/);assert.match(content,/Última resposta recebida/);assert.match(content,/Episódios monitorados/);assert.doesNotMatch(content,/Último resultado salvo|Pronta para consulta|https:\/\/unsafe|secret/);f.cleanup();
});

test('an explicit scope or account reset clears old visible coverage while ordinary refresh retains it',t=>{
  const data=snapshot(),f=controlledView(t,{data,loading:false,error:null});assert.match(text(f.container),/40\.000/);
  f.update({data,loading:true,error:null});assert.match(text(f.container),/40\.000/);
  f.update({data:null,loading:false,error:null});assert.doesNotMatch(text(f.container),/40\.000|8\.124|Registro consultado em/);assert.equal(f.container.querySelector('.marker-sync-results').children.length,0);
  assert.equal(f.container.querySelector('.marker-sync-badge').textContent,'Aguardando registro');f.cleanup();
});

test('coverage timestamps come from saved summaries and never from the report read time',t=>{
  const source=snapshot(),data=snapshot({global:{...source.global,updatedAt:'2026-10-15T10:00:00Z'},catalog:{...source.catalog,updatedAt:'2026-10-15T10:00:00Z'}}),f=controlledView(t,{data,loading:false,error:null});
  const globalTime=f.container.querySelector('.marker-sync-global-timestamp').textContent,catalogTime=f.container.querySelector('.marker-sync-catalog-timestamp').textContent,reportTime=f.container.querySelector('.marker-sync-updated').textContent;
  assert.match(globalTime,/Cobertura atualizada em/);assert.equal(globalTime,catalogTime);assert.notEqual(globalTime.replace('Cobertura atualizada em ',''),reportTime.replace('Registro consultado em ',''));
  f.update({data:snapshot({global:{episodes:null,updatedAt:null},catalog:{series:8124,identifiedSeries:22,episodes:null,withMarkers:null,updatedAt:null}}),loading:false,error:null});
  assert.equal(f.container.querySelector('.marker-sync-global-timestamp').textContent,'Aguardando atualização da cobertura.');assert.match(text(f.container),/8\.124/);assert.match(text(f.container),/— episódios identificados/);f.cleanup();
});
