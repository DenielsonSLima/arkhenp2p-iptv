import test from 'node:test';
import assert from 'node:assert/strict';
import {LibraryArtworkHydrator} from '../web/library-artwork.js';
import {visibleFavoriteArtwork} from '../web/minha-lista/capas.js';
import {MyListOrchestrator} from '../web/minha-lista/orquestrador.js';

const account='a'.repeat(64),poster='/api/shared-image/'+'b'.repeat(64);
const item=(id,extra={})=>({kind:'movie',id:String(id),name:`Fixture ${id}`,libraryId:account,...extra});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('favorite artwork follows each displayed movie/series window without TV or reordering',()=>{
  const items=[item(1),item(2,{kind:'live'}),item(3,{kind:'series'}),item(4),item(5,{kind:'series'}),item(6),item(7,{kind:'series'})];
  const model=new MyListOrchestrator({services:{items:()=>items},getLimit:()=>2});
  assert.deepEqual(model.artworkItems().map(value=>value.id),['1','3','4','5']);
  assert.deepEqual(visibleFavoriteArtwork(null),[]);
});

test('favorite-only titles beyond the old history budget recover with bounded concurrent detail reads',async()=>{
  const items=Array.from({length:39},(_,index)=>item(index+1)),requested=[],resolved=[];
  let active=0,peak=0;
  const model=new LibraryArtworkHydrator({getScope:()=>({account,epoch:1}),getItems:()=>items,maxItems:96,maxEntries:128,
    request:async(path)=>{
      active++;peak=Math.max(peak,active);const query=new URL(path,'http://fixture').searchParams,id=query.get('id');requested.push(id);
      assert.equal(query.get('artwork'),'1');await settle();active--;return item(id,{poster});
    },onResult:(saved,data)=>resolved.push(data.id)});
  try{
    model.ensure();
    for(let turn=0;turn<60&&resolved.length<items.length;turn++)await settle();
    assert.equal(resolved.length,39);assert.equal(requested.length,39);assert.equal(peak,2);assert.equal(model.get(items[38]).poster,poster);
  }finally{model.dispose();}
});

test('artwork recovery ignores another account and protected titles and retires late results',async()=>{
  let scope={account,epoch:1},release,reads=0,results=0;
  const items=[item(1),item(2,{libraryId:'c'.repeat(64)}),item(3,{isAdult:true})];
  const model=new LibraryArtworkHydrator({getScope:()=>scope,getItems:()=>items,
    request:()=>{reads++;return new Promise(resolve=>{release=()=>resolve(item(1,{poster}));});},onResult:()=>results++});
  try{
    model.ensure();assert.equal(reads,1);scope={account:'d'.repeat(64),epoch:2};model.ensure();release();await settle();
    assert.equal(results,0);assert.equal(model.get(items[0]),null);
  }finally{model.dispose();}
});

test('a broken saved favorite cover recovers without a history entry or repeated catalog scans',async()=>{
  const favorite=item(42,{poster}),replacement='/api/shared-image/'+'e'.repeat(64);let reads=0;
  const model=new LibraryArtworkHydrator({getScope:()=>({account,epoch:1}),getItems:()=>[favorite],
    request:async(path)=>{reads++;assert.match(path,/^\/api\/details\?type=movie&id=42&artwork=1$/);return {...favorite,poster:replacement};}});
  try{
    model.ensure();assert.equal(reads,0);
    assert.equal(model.failSource(favorite,poster),true);await settle();
    assert.equal(model.get(favorite)?.poster,replacement);assert.equal(reads,1);
    assert.equal(model.failSource(favorite,poster),false);assert.equal(reads,1);
  }finally{model.dispose();}
});

test('one cloud recovery event renews only transient metadata/source failures',async()=>{
  const saved=item(42,{poster}),protectedItem=item(43,{poster});let reads=0;
  const model=new LibraryArtworkHydrator({getScope:()=>({account,epoch:1}),getItems:()=>[saved,protectedItem],
    request:async path=>{reads++;if(path.includes('id=43&'))throw Object.assign(new Error('not found'),{status:404});return saved;}});
  try{
    model.failSource(saved,poster);model.failSource(protectedItem,poster);await settle();
    assert.equal(model.entries.get('movie:42').lastFailureTransient,true);
    assert.equal(model.entries.get('movie:43').blocked,true);
    const event={state:'synced'};assert.equal(model.recoverCloud(event),true);
    assert.equal(model.failedSources.has('movie:42'),false);assert.equal(model.failedSources.has('movie:43'),true);
    model.failSource(saved,poster);await settle();const before=reads;
    assert.equal(model.recoverCloud(event),false);assert.equal(model.failedSources.has('movie:42'),true);assert.equal(reads,before);
    assert.equal(model.entries.get('movie:43').blocked,true);
    assert.equal(model.recoverCloud({state:'offline'}),false);
    assert.equal(model.recoverCloud({state:'synced'}),true);
    assert.equal(model.recoverCloud(event),false,'An older event remains consumed after a later reconnection.');
  }finally{model.dispose();}
});

test('cloud recovery resumes a missing cover after a transient metadata timeout',async()=>{
  const saved=item(42);let healthy=false,reads=0;
  const model=new LibraryArtworkHydrator({getScope:()=>({account,epoch:1}),getItems:()=>[saved],
    request:async()=>{reads++;if(!healthy)throw Object.assign(new Error('temporarily unavailable'),{status:503});return {...saved,poster};}});
  try{
    model.ensure();await settle();assert.equal(reads,1);healthy=true;
    assert.equal(model.recoverCloud({state:'synced'}),true);await settle();
    assert.equal(reads,2);assert.equal(model.get(saved)?.poster,poster);
  }finally{model.dispose();}
});

test('hiding the artwork window aborts active details, drains no queued title and preserves recovery on return',async()=>{
  let visible=true,aborted=0;const requested=[],pending=[];
  const items=[item(1),item(2),item(3)];
  const model=new LibraryArtworkHydrator({getScope:()=>({account,epoch:1}),getItems:()=>visible?items:[],
    request:(path,{signal})=>new Promise((resolve,reject)=>{
      const id=new URL(path,'http://fixture').searchParams.get('id');requested.push(id);
      const cancel=()=>{aborted++;reject(Object.assign(new Error('Retired artwork window'),{name:'AbortError'}));};
      signal.addEventListener('abort',cancel,{once:true});
      pending.push(()=>{signal.removeEventListener('abort',cancel);resolve(item(id,{poster}));});
    })});
  try{
    model.ensure();assert.deepEqual(requested,['1','2']);
    visible=false;model.ensure();await settle();
    assert.equal(aborted,2);assert.equal(model.active,0);assert.deepEqual(requested,['1','2']);assert.equal(model.queue.length,0);
    assert.ok([...model.entries.values()].every(entry=>entry.attempts===0&&!entry.blocked));
    assert.equal(model.timer,null);
    visible=true;model.ensure();assert.deepEqual(requested,['1','2','1','2']);
    pending[2]();pending[3]();await settle();
    assert.equal(model.get(items[0])?.poster,poster);assert.equal(model.get(items[1])?.poster,poster);
    assert.equal(requested.at(-1),'3');pending.at(-1)();await settle();assert.equal(model.get(items[2])?.poster,poster);
  }finally{model.dispose();}
});
