import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudAppBridge} from '../web/cloud-app-bridge.js';

const NOW=Date.parse('2026-10-15T04:00:00Z');
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const snapshot=(userId='user-a',extra={})=>({ready:true,userId,preferenceRecords:[],collectionRecords:[],...extra});
function fixture(t,{storage,local={},initialGroups=[],remote=snapshot(),connect}={}){
  let session={connected:true,account:{libraryId:'a'.repeat(64)},cloud:{userId:'user-a'}},generation=1,preferences={audio:{mode:'original'},...local},groups=structuredClone(initialGroups),listener,current=remote;
  const calls=[],favorites=new Map([['series:9',{id:'9',kind:'series',name:'Série'}]]),history=new Map(),episodes={list:()=>[{itemId:'9',episodeId:'ep4',season:6,number:4,time:120,duration:3600,updated:NOW}],read:()=>null,save:()=>{}};
  const cloud={subscribe:fn=>{listener=fn;return()=>{listener=null;}},async connect(value){calls.push(['connect',value]);if(connect)return connect(value);listener(current);return current;},snapshot:()=>current,
    hydrate(value){calls.push(['hydrate',value]);},syncLocal:async value=>{calls.push(['syncLocal',value]);return true;},
    saveFavorite:async(...args)=>{calls.push(['favorite',...args]);return true;},saveProgress:async(...args)=>{calls.push(['progress',...args]);return true;},
    savePreference:async(...args)=>{calls.push(['preference',...args]);return true;},saveCollection:async(...args)=>{calls.push(['collection',...args]);return true;},removeCollection:async(...args)=>{calls.push(['removeCollection',...args]);return true;},
    logout:async value=>{calls.push(['logout',value]);}};
  let bridge;bridge=new CloudAppBridge({cloud,getSession:()=>session,getGeneration:()=>generation,favoritesMap:favorites,historyMap:history,episodeProgress:episodes,
    localLibrary:{saveFavorites:()=>calls.push(['saveFavorites']),saveHistory:()=>calls.push(['saveHistory'])},getPreferences:()=>preferences,
    applyPreferences(value){preferences={...preferences,...value};for(const [key,data]of Object.entries(value))void bridge.preferenceChanged(key,data);},
    getCollections:()=>groups,applyCollections:value=>{groups=value;bridge.settingsChanged();},defaultPreferences:{audio:{mode:'original'}},onUpdate:value=>calls.push(['update',value,bridge.applying]),storage,now:()=>NOW});
  t.after(()=>bridge.stop({flush:false}));
  return {bridge,cloud,calls,favorites,history,episodes,get preferences(){return preferences;},get groups(){return groups;},setGroups(value){groups=value;},setPreferences(value){preferences=value;},
    emit(value){current=value;listener(value);},account(id,user){generation++;session={connected:true,account:{libraryId:id.repeat(64)},cloud:{userId:user}};},setSnapshot:value=>{current=value;}};
}

test('account start imports exact episode progress and seeds missing preferences without feedback writes',async t=>{
  const f=fixture(t,{initialGroups:[{id:'my-list',name:'Favoritos',type:'series',itemKeys:['series:9']}]});await f.bridge.start();
  const imported=f.calls.find(([type])=>type==='syncLocal')[1];assert.equal(imported.libraryId,'a'.repeat(64));assert.equal(imported.favoritesMap,f.favorites);
  assert.deepEqual(imported.episodeEntries[0].episode,{id:'ep4',season:6,number:4,title:''});assert.equal(imported.episodeEntries[0].libraryId,'a'.repeat(64));
  assert.equal(f.calls.filter(([type])=>type==='preference').length,1);assert.deepEqual(f.calls.find(([type])=>type==='collection')[1],{id:'my-list',name:'Favoritos',collection_type:'series',item_keys:['series:9']});
  assert.equal(f.calls.find(([type])=>type==='update')[2],true,'Rendering remote data keeps mutation callbacks guarded.');
});

test('Realtime changes merge collections and preferences once and preserve their newer revision',async t=>{
  const f=fixture(t,{initialGroups:[{id:'old',name:'Antiga',type:'movies',itemKeys:[]}]});await f.bridge.start();f.calls.length=0;
  const rows=[{key:'audio',value:{mode:'night'},updated_at:new Date(NOW+1000).toISOString()}],groups=[{id:'old',deleted_at:new Date(NOW+1000).toISOString(),updated_at:new Date(NOW+1000).toISOString()},{id:'new',name:'Ação',collection_type:'movies',item_keys:['movie:3'],updated_at:new Date(NOW+1000).toISOString()}];
  f.emit(snapshot('user-a',{preferenceRecords:rows,collectionRecords:groups}));assert.equal(f.preferences.audio.mode,'night');assert.deepEqual(f.groups,[{id:'new',name:'Ação',type:'movies',itemKeys:['movie:3']}]);
  assert.equal(f.calls.some(([type])=>['preference','collection','removeCollection'].includes(type)),false);assert.equal(f.calls.filter(([type])=>type==='hydrate').length,1);
  f.emit(snapshot('user-a',{preferenceRecords:[{...rows[0],updated_at:new Date(NOW+3000).toISOString()}]}));
  f.emit(snapshot('user-a',{preferenceRecords:[{...rows[0],value:{mode:'speech'},updated_at:new Date(NOW+2000).toISOString()}]}));
  assert.equal(f.preferences.audio.mode,'night','An older event cannot override a newer same-value revision.');
});

test('explicit favorite, forced progress and collection removal reach the right cloud adapters',async t=>{
  const group={id:'my-list',name:'Minha lista',type:'movies',itemKeys:['movie:3']},f=fixture(t,{initialGroups:[group]});await f.bridge.start();f.calls.length=0;
  const item={kind:'movie',id:'3'},entry={item,time:30,duration:120};await f.bridge.favoriteChanged(item,false);await f.bridge.progressChanged(entry,{force:true});f.setGroups([]);f.bridge.settingsChanged();await flush();
  assert.deepEqual(f.calls.find(([type])=>type==='favorite').slice(1),[item,false]);assert.deepEqual(f.calls.find(([type])=>type==='progress').slice(1),[entry,{force:true}]);
  assert.deepEqual(f.calls.find(([type])=>type==='removeCollection')[1],{id:'my-list',name:'Minha lista',collection_type:'movies',item_keys:['movie:3']});
  const removals=f.calls.filter(([type])=>type==='removeCollection').length;f.bridge.settingsChanged();assert.equal(f.calls.filter(([type])=>type==='removeCollection').length,removals);
});

test('local account preferences restore only to their own account and still seed an empty cloud',async t=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)},f=fixture(t,{storage});await f.bridge.start();await f.bridge.preferenceChanged('audio',{mode:'night'});await f.bridge.stop({flush:false});
  f.account('b','user-b');f.setSnapshot(snapshot('user-b'));await f.bridge.start();assert.equal(f.preferences.audio.mode,'original');await f.bridge.stop({flush:false});
  f.account('a','user-a');f.setSnapshot(snapshot());f.calls.length=0;await f.bridge.start();assert.equal(f.preferences.audio.mode,'night');assert.deepEqual(f.calls.find(([type])=>type==='preference').slice(1),['audio',{mode:'night'}]);
});

test('a late connection cannot import the previous account after an account switch',async t=>{
  const pending=defer(),f=fixture(t,{connect:()=>pending.promise}),starting=f.bridge.start();await flush();f.account('b','user-b');await f.bridge.stop({flush:false});pending.resolve(snapshot());assert.equal(await starting,null);
  assert.equal(f.calls.some(([type])=>type==='syncLocal'),false);assert.equal(await f.bridge.favoriteChanged({id:'3',kind:'movie'}),false);
});

test('a foreign account snapshot cannot hydrate private maps or overwrite preferences',async t=>{
  const f=fixture(t);await f.bridge.start();f.calls.length=0;f.emit(snapshot('user-b',{preferenceRecords:[{key:'audio',value:{mode:'night'},updated_at:new Date(NOW+1000).toISOString()}]}));
  assert.equal(f.calls.length,0);assert.equal(f.preferences.audio.mode,'original');
});
