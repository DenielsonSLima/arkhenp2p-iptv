import test from 'node:test';
import assert from 'node:assert/strict';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {ProviderError} from '../lib/provider.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';

function fixture({nativeHTTP=true}={}){
 let webFactories=0;
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'},
  {webPlayback:true,webPlaybackFactory:()=>{webFactories++;throw new ProviderError('Synthetic ambiguous catalogue','WPLAY_WEB_CHANNEL_AMBIGUOUS',409);}});
 client.item=async()=>({id:'130',kind:'live',name:'Canal sintético'});
 client.rawItems.set('live:130',{sources:nativeHTTP?['HD','FHD','4K'].map(quality=>({subTitle:quality,address:`https://synthetic.invalid/${quality}.m3u8`})):[{address:'tvbus://synthetic'}]});
 return{client,get webFactories(){return webFactories;}};
}

test('automatic source preparation uses native HTTP without OTT auth or catalogue and selects highest declared quality',async()=>{
 const f=fixture();
 try{
  const value=await f.client.liveSources('130');
  assert.equal(f.webFactories,0);
  assert.equal(value.sources.find(source=>source.id===value.selectedSourceId)?.quality,'4K');
  assert.equal(value.sources.length,3);
  assert.doesNotMatch(JSON.stringify(value),/https:|synthetic.invalid/);
 }finally{await f.client.logout();}
});

test('a failed explicit OTT catalogue cannot disable an authorized native HTTP source',async()=>{
 const f=fixture();
 try{
  const value=await f.client.liveSources('130',{includeWeb:true});
  assert.equal(f.webFactories,1);
  assert.equal(value.sources.find(source=>source.id===value.selectedSourceId)?.quality,'4K');
 }finally{await f.client.logout();}
});

test('without native HTTP, conservative OTT mapping errors still propagate',async()=>{
 const f=fixture({nativeHTTP:false});
 try{await assert.rejects(()=>f.client.liveSources('130'),{code:'WPLAY_WEB_CHANNEL_AMBIGUOUS',status:409});}
 finally{await f.client.logout();}
});

test('source discovery reuses an authorized warm native catalogue without a five-minute login refresh',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});let authCalls=0,catalogCalls=0;
 client.libraryProvider='wplay';client.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};
 client.authenticatedAt=Date.now()-600000;client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.authenticate=async()=>{authCalls++;throw new Error('A warm metadata read must not log in again.');};
 client.requestJSON=async()=>{catalogCalls++;throw new Error('A warm catalogue must not be downloaded again.');};
 const raw={chid:'130',name:'Canal sintético',sources:[{subTitle:'FHD',address:'https://synthetic.invalid/fhd.m3u8'}]},catalog=client.normalizeItems([raw],'live');
 client.cache.set('catalog:live',{time:Date.now(),promise:Promise.resolve(catalog)});
 try{
  const result=await client.liveSources('130');assert.equal(result.sources.length,1);assert.equal(result.sources[0].quality,'FHD');
  assert.equal(authCalls,0);assert.equal(catalogCalls,0);
 }finally{await client.logout();}
});

test('a cancelled native source reader cannot discard the shared account catalogue for another channel reader',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});let release,enter,catalogCalls=0;
 const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});
 client.libraryProvider='wplay';client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now();
 client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.requestJSON=async()=>{catalogCalls++;enter();await gate;return[{chid:'130',name:'Canal sintético',sources:[{subTitle:'FHD',address:'https://synthetic.invalid/fhd.m3u8'}]}];};
 const controller=new AbortController(),first=client.liveSources('130',{signal:controller.signal});
 const rejected=assert.rejects(first,{code:'PLAYBACK_CANCELLED'});await entered;controller.abort();
 const next=client.liveSources('130');release();
 try{await rejected;assert.equal((await next).sources.length,1);assert.equal(catalogCalls,1);}
 finally{await Promise.allSettled([first,next]);await client.logout();}
});

test('cold source discovery preserves native catalogues larger than the EPG publication subset',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});
 client.libraryProvider='wplay';client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now();
 client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.requestJSON=async()=>Array.from({length:2001},(_,index)=>({chid:String(index+1),name:`Synthetic ${index+1}`,
  sources:[{subTitle:'FHD',address:`https://synthetic.invalid/${index+1}.m3u8`}]}));
 try{assert.equal((await client.liveSources('130')).sources.length,1);}finally{await client.logout();}
});

test('parental source validation shares the native catalogue without cloud lookup or renewed login',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});let catalogs=0;
 client.libraryProvider='wplay';client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now()-600000;
 client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.authenticate=async()=>{throw new Error('Source authorization must not refresh login.');};
 client.requestJSON=async()=>{catalogs++;return[
  {chid:'130',name:'Canal sintético',tags:[{_id:'1',name:'Canais'}],sources:[{address:'https://synthetic.invalid/live.m3u8'}]},
  {chid:'543',name:'Restrito',restrictedAccess:true,tags:[{_id:'2',name:'Adultos'}],sources:[{address:'https://synthetic.invalid/restricted.m3u8'}]}
 ];};
 const parental=new ParentalControl({lookupItem:async()=>{throw new Error('No cloud dependency in native source authorization.');}});
 const loadCatalog=()=>client.liveSourceCatalog();
 try{
  await parental.authorize(client,'live','130',{loadCatalog});
  assert.equal((await client.liveSources('130')).sources.length,1);assert.equal(catalogs,1);
  await assert.rejects(()=>parental.authorize(client,'live','543',{loadCatalog}),{code:'PARENTAL_LOCKED'});
  await assert.rejects(()=>parental.authorize(client,'live','999',{loadCatalog}),{code:'PARENTAL_LOCKED'});
  assert.equal(catalogs,1);
 }finally{await client.logout();}
});

test('source authorization refreshes expired catalogue metadata without renewing account login',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});let reads=0;
 client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now()-600000;
 client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.cache.set('catalog:live',{time:Date.now()-900001,promise:Promise.resolve({items:[],categories:[]})});
 client.connect=async()=>{throw new Error('No login refresh.');};
 client.requestJSON=async()=>{reads++;return[{chid:'130',name:'Canal sintético'}];};
 try{assert.equal((await client.liveSourceCatalog()).items[0].id,'130');await client.liveSourceCatalog();assert.equal(reads,1);}
 finally{await client.logout();}
});

test('source authorization cannot consume a shared catalogue after its authentication generation changes',async()=>{
 const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});let release,current=true;
 client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now();
 client.authInfo={service:{enabledLive:true,ch_url:'https://synthetic.invalid/catalog'}};
 client.cache.set('catalog:live',{time:Date.now(),promise:new Promise(resolve=>{release=resolve;})});
 const pending=client.liveSourceCatalog({current:()=>current}),rejected=assert.rejects(pending,{code:'WPLAY_EPG_SOURCE_CANCELLED'});
 current=false;release({categories:[],items:[{id:'130',kind:'live'}]});
 try{await rejected;}finally{await client.logout();}
});
