import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ParentalControl} from '../lib/parental-control.mjs';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {captureRuntimeSession,restoreRuntimeSession} from '../lib/runtime-session-state.mjs';
import {OrquestradorConexaoWplay} from '../lib/wplay/orquestrador.mjs';

const categories=[{id:'safe',name:'Ação'},{id:'adult',name:'Adultos +18'},{id:'merged',ids:new Set(['restricted-alias']),name:'Restritos',isAdult:true}];
const fresh=lookupItem=>({client:null,loggedOut:false,authGeneration:1,seen:Date.now(),attempts:[],parental:new ParentalControl({lookupItem})});
const store=()=>new RuntimeSessionStore({cloud:{runtimeSessionKey:()=>Buffer.alloc(32,17)}});
const hash='f'.repeat(64);
const owner=()=>new OrquestradorConexaoWplay();
const fixtureClient=async factory=>{
  const client=await factory.createClient(factory.resolveConnection({provider:'wplay',username:'fixture',password:'fixture'}));
  client.libraryProvider='wplay';client.session={connected:true,account:{status:'Active'}};client.authenticatedAt=Date.now();
  return client;
};
const restore=async(dto,createState=fresh,factory=owner())=>restoreRuntimeSession(dto,{createState,createClient:async({provider,config})=>{
  const connection=factory.resolveConnection({provider,...config});
  return factory.createClient({...connection,config:{...connection.config,...config}});
}});
const codec=async value=>{const runtime=store();return runtime.openCipher(await runtime.seal(value,hash),hash);};

test('large movie and series catalogues fit the unchanged runtime limit without retaining presentation metadata',async t=>{
  const state=fresh(),factory=owner();state.client=await fixtureClient(factory);
  for(const [type,kind,count]of [['movies','movie',12000],['series','series',8000]]){
    const items=Array.from({length:count},(_,index)=>({id:String(index+1),kind,name:`Fixture ${kind} ${index}`,
      categoryId:'safe',plot:randomBytes(768).toString('hex'),poster:'/api/shared-image/'+randomBytes(32).toString('hex')}));
    state.parental.rememberCatalog({categories,items},type);
  }
  const oldParent={unlocked:false,failed:0,blockedUntil:0,items:new Map(state.parental.items),categories:new Map(state.parental.categories),
    episodes:new Map(),artworks:new Map(state.parental.artworks)};
  const dto=captureRuntimeSession(state),runtime=store();
  await assert.rejects(runtime.seal({...dto,parental:oldParent},hash),{code:'RUNTIME_SESSION_TOO_LARGE'});
  const ciphertext=await runtime.seal(dto,hash);
  assert.ok(ciphertext.length<2*1024*1024,`Compact fixture used ${ciphertext.length} bytes`);
  t.diagnostic(`20000 synthetic catalogue items: compact encrypted checkpoint ${ciphertext.length} bytes; legacy checkpoint exceeds 3 MiB`);
  assert.equal(dto.parental.items.size,20000);
  assert.equal(dto.parental.artworks.size,20000);
  for(const item of dto.parental.items.values())assert.deepEqual(Object.keys(item).sort(),['categoryIds','classified','id','isAdult','kind']);
  const revived=await restore(await runtime.openCipher(ciphertext,hash),fresh,factory);
  assert.equal(revived.client.constructor.name,'WplayPlaybackProviderClient');
  revived.parental.assertPlayback('movie','12000');revived.parental.assertItem('series','8000');
  assert.equal(revived.parental.items.size,20000);
  assert.equal(revived.client.nativeVOD.registered,false);
});

test('a native WPLAY client retains an authorized episode across compaction without serializing pending catalogue promises',async()=>{
  const factory=owner(),state=fresh();state.client=await fixtureClient(factory);
  state.client.authInfo={service:{enabledLive:true,token:'synthetic-fixture'}};
  state.client.nativeVOD.categories.set('safe',{id:'safe',name:'Ação',url:'https://catalog.example.com/fixture',restricted:false});
  state.client.nativeVOD.pages.set('series:safe',{nextPage:2,hasMore:true,loaded:true});
  state.client.nativeVOD.initializing.set('series',Promise.resolve());
  state.client.episodes.set('101',{id:'101',season:1,number:1,source:{address:'https://media.example.com/fixture.mp4'}});
  state.parental.rememberCatalog({categories,items:[{id:'10',kind:'series',categoryId:'safe',plot:'Unneeded catalogue metadata'}]},'series');
  state.parental.registerDetails('series','10',{seasons:[{episodes:[{id:'101'}]}]});
  state.client.beginPlayback('series:101');
  const revived=await restore(await codec(captureRuntimeSession(state)),fresh,factory);
  assert.equal(revived.client.constructor.name,'WplayPlaybackProviderClient');
  assert.equal(revived.client.nativeVOD.initializing.size,0);
  assert.equal(revived.client.authInfo.service.enabledLive,true);
  assert.equal(revived.client.episodes.get('101').source.address,'https://media.example.com/fixture.mp4');
  revived.parental.assertPlayback('series','101');
  assert.throws(()=>revived.parental.assertPlayback('series','102'),{code:'PARENTAL_LOCKED'});
});

test('compact encrypted round trips preserve adult, unknown, episode and shared-artwork denials',async()=>{
  const state=fresh(),poster='/api/image?ref=shared-fixture';
  state.parental.rememberCatalog({categories,items:[
    {id:'1',kind:'movie',name:'Safe',categoryId:'safe',poster},
    {id:'2',kind:'movie',name:'Adult',categoryId:'adult',poster},
    {id:'3',kind:'movie',name:'Safe name',categoryId:'restricted-alias'},
    {id:'4',kind:'movie',name:'XXX content',categoryId:'safe'},
    {id:'5',kind:'movie',name:'Adult Swim',categoryId:'safe'},
  ]},'movies');
  state.parental.rememberCatalog({categories,items:[{id:'10',kind:'series',categoryId:'safe'},{id:'11',kind:'series',categoryId:'adult'}]},'series');
  state.parental.registerDetails('series','10',{plot:'Do not retain',seasons:[{episodes:[{id:'101',thumbnail:'/api/image?ref=episode-safe'}]}]});
  state.parental.registerDetails('series','11',{seasons:[{episodes:[{id:'102'}]}]});
  state.parental.items.set('movie:99',{id:'99',kind:'movie',name:'Unclassified',classified:false,isAdult:false});
  const revived=await restore(await codec(captureRuntimeSession(state)));
  for(const id of ['2','3','4','99','unknown'])assert.throws(()=>revived.parental.assertPlayback('movie',id),{code:'PARENTAL_LOCKED'});
  revived.parental.assertPlayback('movie','1');revived.parental.assertPlayback('movie','5');revived.parental.assertPlayback('series','101');
  assert.throws(()=>revived.parental.assertPlayback('series','102'),{code:'PARENTAL_LOCKED'});
  assert.throws(()=>revived.parental.assertPlayback('series','unknown'),{code:'PARENTAL_LOCKED'});
  await assert.rejects(revived.parental.authorizeArtwork(poster),{code:'PARENTAL_LOCKED'});
  await revived.parental.authorizeArtwork('/api/image?ref=episode-safe');
  revived.parental.unlock('0000');revived.parental.assertPlayback('movie','2');revived.parental.lock();
  assert.throws(()=>revived.parental.assertPlayback('movie','2'),{code:'PARENTAL_LOCKED'});
  assert.equal(revived.parental.items.get('series:10').seasons,undefined);
});

test('PIN cooldown, unlock state and authorization lookup survive restoration without storing a PIN',async()=>{
  const state=fresh();for(let attempt=0;attempt<5;attempt++)assert.throws(()=>state.parental.unlock('1111'));
  const locked=await restore(await codec(captureRuntimeSession(state)));
  assert.throws(()=>locked.parental.unlock('0000'),{code:'PARENTAL_RATE_LIMITED'});
  assert.ok(locked.parental.status().retryAfterSeconds>0);
  state.parental.reset();state.parental.unlock('0000');
  const unlocked=await restore(await codec(captureRuntimeSession(state)));
  assert.equal(unlocked.parental.unlocked,true);unlocked.parental.lock();
  let lookups=0;
  const revived=await restore(await codec(captureRuntimeSession(fresh())),()=>fresh(async(kind,id)=>{
    lookups++;return {categories,items:[{kind,id,name:'Looked up',categoryId:'safe'}]};
  }));
  await revived.parental.authorize({catalog:()=>assert.fail('Cloud lookup should suffice')},'movie','200');
  assert.equal(lookups,1);revived.parental.assertPlayback('movie','200');
  assert.equal(Object.hasOwn(captureRuntimeSession(unlocked).parental,'pin'),false);
});

test('legacy parental DTOs are compacted when restored and retain adult ownership',()=>{
  const original=new ParentalControl();original.rememberCatalog({categories,items:[{id:'1',kind:'movie',name:'Safe',plot:'large',categoryId:'safe'}]},'movies');
  const legacy={unlocked:false,failed:0,blockedUntil:0,items:original.items,categories:original.categories,episodes:original.episodes,artworks:original.artworks};
  const revived=new ParentalControl().restoreRuntimeState(legacy);
  revived.assertItem('movie','1');assert.equal(revived.items.get('movie:1').plot,undefined);
  assert.throws(()=>revived.assertItem('movie','2'),{code:'PARENTAL_LOCKED'});
});
