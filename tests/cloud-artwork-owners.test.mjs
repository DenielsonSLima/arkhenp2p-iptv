import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64),ref='c'.repeat(64),artwork='/api/shared-image/'+ref;
const owner=(type,id)=>({media_type:type,media_id:id});
const media=(type,id,adult=false)=>({...owner(type,id),is_adult:adult,metadata:{id:'untrusted',kind:'untrusted',name:'Título',isAdult:false}});
function fixture(refs,rows){
  const requests=[],cloud={enabled:true,ready:Promise.resolve(true),request:async(path,options)=>{
    const url=new URL(path,'https://fixture.invalid');requests.push({url,options});
    assert.equal(url.searchParams.get('provider_key'),'eq.'+providerKey);assert.equal(url.searchParams.get('scope_hash'),'eq.'+scopeHash);
    if(url.pathname.endsWith('/catalog_artwork_refs'))return typeof refs==='function'?refs():refs;
    assert.equal(url.pathname,'/rest/v1/catalog_media');assert.equal(url.searchParams.get('is_active'),'eq.true');
    const type=url.searchParams.get('media_type').slice(3);
    return typeof rows==='function'?rows(type):rows.filter(row=>row.media_type===type);
  }};
  const runtime=new CloudRuntime({cloud,workerEnabled:false}),state={cloud:{providerKey,scopeHash,session:{access_token:'fixture'}},client:{},authGeneration:1,parental:new ParentalControl()};
  return {runtime,state,requests,close:()=>runtime.close()};
}

test('shared artwork checks every unique owner in bounded per-type batches',async()=>{
  const f=fixture([owner('movies','1'),owner('movies','2'),owner('movies','1'),owner('series','3'),owner('live','4')],
    [media('movies','1'),media('movies','2'),media('series','3'),media('live','4')]);
  try{
    const result=await f.runtime.parentalArtworkItem(f.state,ref);
    assert.deepEqual(result.catalog.items.map(item=>[item.kind,item.id]),[['movie','1'],['movie','2'],['series','3'],['live','4']]);
    assert.ok(result.catalog.items.every(item=>item.poster===artwork&&item.isAdult===false));
    assert.equal(f.requests.length,4);assert.equal(f.requests[0].url.searchParams.get('limit'),'65');
    assert.equal(f.requests.find(({url})=>url.searchParams.get('media_type')==='eq.movies').url.searchParams.get('media_id'),'in.(1,2)');
    await f.state.parental.authorizeArtwork(artwork,()=>Promise.resolve(result));
    await f.runtime.parentalArtworkItem(f.state,ref);assert.equal(f.requests.length,4);
  }finally{f.close();}
});

test('one adult owner denies the shared reference even when another owner is safe',async()=>{
  const f=fixture([owner('movies','1'),owner('series','2')],[media('movies','1'),media('series','2',true)]);
  try{
    // A previously loaded safe page must not bypass the complete shared lookup.
    f.state.parental.rememberCatalog({categories:[],items:[{id:'1',kind:'movie',isAdult:false,poster:artwork}]},'movies');
    await f.state.parental.authorizeArtwork(artwork);
    const result=await f.runtime.parentalArtworkItem(f.state,ref);
    assert.equal(result.catalog.items[1].isAdult,true);
    await assert.rejects(f.state.parental.authorizeArtwork(artwork,()=>Promise.resolve(result)),{code:'PARENTAL_LOCKED'});
  }finally{f.close();}
});

test('the maximum 64-owner proof uses one bounded metadata batch',async()=>{
  const ids=Array.from({length:64},(_,i)=>String(i+1)),f=fixture(ids.map(id=>owner('movies',id)),ids.map(id=>media('movies',id)));
  try{
    const result=await f.runtime.parentalArtworkItem(f.state,ref);
    assert.equal(result.catalog.items.length,64);assert.equal(f.requests.length,2);
    assert.equal(f.requests[1].url.searchParams.get('limit'),'64');
    assert.equal(f.requests[1].url.searchParams.get('media_id'),'in.('+ids.join(',')+')');
  }finally{f.close();}
});

test('unknown reference stays unauthorized without querying owner metadata',async()=>{
  const f=fixture([],[]);
  try{
    assert.equal(await f.runtime.parentalArtworkItem(f.state,ref),null);assert.equal(f.requests.length,1);
    f.state.parental.rememberCatalog({categories:[],items:[{id:'1',kind:'movie',poster:artwork}]},'movies');
    await assert.rejects(f.state.parental.authorizeArtwork(artwork,()=>f.runtime.parentalArtworkItem(f.state,ref)),{code:'PARENTAL_LOCKED'});
  }finally{f.close();}
});

test('incomplete, ambiguous or oversized owner proofs fail closed',async t=>{
  const cases=[
    ['65 references',Array.from({length:65},(_,i)=>owner('movies',String(i))),[]],
    ['unsupported owner',[owner('unknown','1')],[]],
    ['invalid owner id',[owner('movies','1,2')],[]],
    ['missing metadata',[owner('movies','1')],[]],
    ['unclassified owner',[owner('movies','1')],[{...media('movies','1'),is_adult:null}]],
    ['array metadata',[owner('movies','1')],[{...media('movies','1'),metadata:[]}]],
    ['duplicate metadata',[owner('movies','1'),owner('movies','2')],[media('movies','1'),media('movies','1')]],
    ['unexpected metadata',[owner('movies','1')],[media('movies','2')]],
  ];
  for(const [name,refs,rows]of cases)await t.test(name,async()=>{
    const f=fixture(refs,rows);try{await assert.rejects(f.runtime.parentalArtworkItem(f.state,ref),{status:503,code:'CLOUD_ARTWORK_UNAVAILABLE'});}finally{f.close();}
  });
});

test('transport failure is sanitized and briefly coalesced; changed scope cannot receive a pending proof',async()=>{
  const failure=Object.assign(new Error('private token URL'),{cloudStage:'artwork_reference',elapsedMs:5000});
  const f=fixture(()=>{throw failure;},[]);
  try{
    for(let i=0;i<2;i++)await assert.rejects(f.runtime.parentalArtworkItem(f.state,ref),error=>error.code==='CLOUD_ARTWORK_UNAVAILABLE'&&error.status===503&&error.cloudStage==='artwork_reference'&&error.elapsedMs===5000&&!/private|token|URL/.test(error.message));
    assert.equal(f.requests.length,1);
  }finally{f.close();}
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const changed=fixture(async()=>{await gate;return [owner('movies','1')];},[media('movies','1')]);
  try{
    const pending=changed.runtime.parentalArtworkItem(changed.state,ref);changed.state.parental.unlocked=true;release();
    await assert.rejects(pending,{status:503,code:'CLOUD_ARTWORK_UNAVAILABLE'});
  }finally{changed.close();}
});
