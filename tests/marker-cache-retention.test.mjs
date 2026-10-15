import test from 'node:test';
import assert from 'node:assert/strict';
import {expiredCacheObjects,retainMarkerCaches} from '../supabase/functions/series-markers-sync/retention.mjs';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
const NOW=Date.parse('2026-10-15T12:00:00Z'),current='20261015T100000Z',old='20261010T100000Z';
const key=(generation=old,part='a')=>'skipdb-'+generation+'-part-'+part.repeat(24)+'.jsonl';
const file=(name,extra={})=>({id:'fixture',name,created_at:new Date(NOW-4*86400000).toISOString(),updated_at:new Date(NOW-4*86400000).toISOString(),...extra});

test('retention keeps current, referenced, recently changed, unknown and folder objects while respecting the three-day boundary',()=>{
  const context={generation:current,raw_object:'skipdb-raw-'+old+'.json',dump_object:key(old,'b'),public_keys:[key(old,'c')]};
  const rows=[file(key()),file(key(current)),file(key(old,'b')),file(key(old,'c')),file(key(old,'d'),{updated_at:new Date(NOW-86400000).toISOString()}),file('private-user-file.json'),file(key(old,'e'),{id:null}),file(key(old,'f'),{created_at:null}),file(key(old,'1'),{created_at:new Date(NOW-3*86400000).toISOString(),updated_at:new Date(NOW-3*86400000).toISOString()})];
  assert.deepEqual(expiredCacheObjects(rows,{kind:'public',context,now:NOW}),[key(),key(old,'1')]);
  assert.deepEqual(expiredCacheObjects([file(context.raw_object),file('skipdb-raw-'+current+'.json'),file('skipdb-raw-20261009T100000Z.json')],{kind:'raw',context,now:NOW}),['skipdb-raw-20261009T100000Z.json']);
});

test('cleanup is bounded across both buckets, advances its scan cursor and uses fresh SQL reference checks immediately before removal',async()=>{
  const calls=[],checkpoints=[],context={generation:current,public_keys:[key(old,'b')],public_offset:0,raw_offset:0,removed_segments:5000,removed_groups:7};
  const raw=Array.from({length:10},(_,index)=>file('skipdb-raw-2026100'+index+'T100000Z.json'));
  const publicRows=Array.from({length:100},(_,index)=>file('skipdb-202609'+String(index).padStart(2,'0')+'T100000Z.jsonl'));
  const store={async rpc(name,args){calls.push([name,args]);if(name==='arkhen_marker_retention_context')return context;return {raw:args.p_raw,public:args.p_public,lease_until:new Date(NOW+30000).toISOString()};},
    async storageList(bucket){return bucket==='arkhen-marker-staging'?raw:publicRows;},async storageRemove(bucket,keys){calls.push(['remove',bucket,keys]);return keys.length;},async checkpoint(_owner,patch){checkpoints.push(patch);}};
  const result=await retainMarkerCaches({store,owner:'fixture',now:()=>NOW});assert.equal(result.objectsRemoved,20);assert.equal(result.segmentsRemoved,5000);
  assert.deepEqual(calls.filter(([name])=>name==='remove').map(([,bucket,keys])=>[bucket,keys.length]),[['arkhen-marker-staging',10],['arkhen-marker-open-data',10]]);
  assert.equal(checkpoints[0].retention_public_offset,90);assert.equal(checkpoints[0].retention_raw_offset,0);
  const removeIndex=calls.findIndex(([name])=>name==='remove');assert.equal(calls[removeIndex-1][0],'arkhen_marker_retention_candidates');
});

test('a newly retained reference or an expired lease prevents deletion even when a previous listing considered the file obsolete',async()=>{
  for(const expired of [false,true]){
    let removed=false;const store={async rpc(name){return name==='arkhen_marker_retention_context'?{generation:current,public_keys:[]}: {raw:[],public:[key(),'unrequested.json'],lease_until:new Date(NOW+(expired?5000:30000)).toISOString()};},
      async storageList(bucket){return bucket==='arkhen-marker-open-data'?[file(key())]:[];},async storageRemove(_bucket,keys){removed=true;assert.deepEqual(keys,[key()]);return 1;},async checkpoint(){}};
    if(!expired)store.rpc=async(name)=>name==='arkhen_marker_retention_context'?{generation:current,public_keys:[]}:{raw:[],public:[],lease_until:new Date(NOW+30000).toISOString()};
    await retainMarkerCaches({store,owner:'fixture',now:()=>NOW});assert.equal(removed,false);
  }
});

test('the object cap counts attempted API removals even if Storage reports that some objects were already absent',async()=>{
  let attempted=0;const rows=Array.from({length:25},(_,index)=>file('skipdb-raw-202609'+String(index).padStart(2,'0')+'T100000Z.json'));
  const store={async rpc(name,args){return name==='arkhen_marker_retention_context'?{generation:current,public_keys:[]}:{raw:args.p_raw,public:args.p_public,lease_until:new Date(NOW+30000).toISOString()};},
    async storageList(bucket){return bucket==='arkhen-marker-staging'?rows:[file(key())];},async storageRemove(_bucket,keys){attempted+=keys.length;return 0;},async checkpoint(){}};
  await retainMarkerCaches({store,owner:'fixture',now:()=>NOW});assert.equal(attempted,20);
});

test('storage cleanup uses the official object API and rejects other buckets, unbounded batches and path traversal',async()=>{
  const calls=[],store=new MarkerStore({url:'https://fixture.supabase.co',key:'sb_secret_fixture',fetch:async(url,options)=>{calls.push({url,options});const body=JSON.parse(options.body);assert.equal(options.headers.Authorization,undefined);return new Response(JSON.stringify(options.method==='DELETE'?body.prefixes.map(name=>({name})):[]));}});
  await store.storageList('arkhen-marker-open-data',0,100);assert.match(calls[0].url,/\/storage\/v1\/object\/list\/arkhen-marker-open-data$/);assert.equal(JSON.parse(calls[0].options.body).sortBy.column,'name');
  assert.equal(await store.storageRemove('arkhen-marker-open-data',[key()]),1);assert.equal(calls[1].options.method,'DELETE');assert.deepEqual(JSON.parse(calls[1].options.body),{prefixes:[key()]});
  await assert.rejects(store.storageRemove('user-files',[key()]),{code:'MARKER_RETENTION_DELETE_INVALID'});
  await assert.rejects(store.storageRemove('arkhen-marker-open-data',['../user-files/private']),{code:'MARKER_RETENTION_DELETE_INVALID'});
  await assert.rejects(store.storageRemove('arkhen-marker-open-data',Array(21).fill(key())),{code:'MARKER_RETENTION_DELETE_INVALID'});
  assert.equal(calls.length,2);
});
