import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWplayWebLiveItems,initialWplayWebMatch} from '../lib/wplay/ao-vivo/resolver-web.mjs';
import {WplayWebPlayback} from '../lib/wplay/ao-vivo/transporte-web.mjs';

function fixture(rows){
  const identities=new Map(),rawItems=new Map(),items=[];
  for(const row of rows){
    for(const variant of row.liveVariants||[{quality:''}]){
      const key=`item:live:${row.id}:quality:${variant.quality}`,id=identities.get(key)||String(identities.size+1000);
      identities.set(key,id);items.push({id,kind:'live',name:`${row.title} ${variant.quality}`.trim()});
      rawItems.set(`live:${id}`,{...row,playbackUrl:variant.playbackUrl||row.playbackUrl});
    }
  }
  const catalog={items},client={rawItems,identity:key=>identities.get(key),connect:async()=>{},catalog:async()=>catalog,stopPlayback:async()=>{},logout:async()=>{}};
  return {client,catalog};
}
const channel=(id,title,qualities=['HD','FHD'])=>({id,title,liveVariants:qualities.map(quality=>({quality,playbackUrl:`https://private.invalid/${id}?token=secret-${quality}`}))});
const live=(id,name)=>({id,name,kind:'live'});

test('missing mapping reports bounded public candidates without accepting a partial title',()=>{
  const f=fixture([channel('private-raw-id','Record News'),...Array.from({length:20},(_,index)=>channel(`private-${index}`,`Record Região ${index}`)),channel('url-secret','Record https://private.invalid/token')]);
  let error;try{resolveWplayWebLiveItems(live('543','Record TV News'),f.client,f.catalog);}catch(value){error=value;}
  assert.equal(error.code,'WPLAY_WEB_CHANNEL_NOT_FOUND');assert.equal(error.status,404);
  const diagnostic=error.mappingDiagnostic;
  assert.deepEqual(diagnostic.nativeChannel,{id:'543',name:'Record TV News'});
  assert.equal(diagnostic.matchedCount,0);assert.equal(diagnostic.candidateCount,22);assert.equal(diagnostic.candidates.length,8);
  assert.deepEqual(diagnostic.candidates[0],{name:'Record News',qualities:['hd','fhd']});
  assert.doesNotMatch(JSON.stringify(diagnostic),/private|secret|https|playbackUrl|rawId/);
  assert.equal(Object.prototype.propertyIsEnumerable.call(error,'mappingDiagnostic'),false);
  assert.doesNotMatch(JSON.stringify(error),/Record News|candidates/);
});

test('same provider ID repeated in categories is harmless; distinct same-name IDs remain ambiguous',()=>{
  const duplicated=channel('private-one','Rede TV',['4K','HD']);
  const f=fixture([duplicated,duplicated]);
  assert.ok(resolveWplayWebLiveItems(live('130','Rede TV 4K'),f.client,f.catalog).length>0);
  const ambiguous=fixture([duplicated,channel('private-two','Rede TV',['4K','HD'])]);
  assert.throws(()=>resolveWplayWebLiveItems(live('130','Rede TV 4K'),ambiguous.client,ambiguous.catalog),error=>{
    assert.equal(error.code,'WPLAY_WEB_CHANNEL_AMBIGUOUS');assert.equal(error.status,409);
    assert.equal(error.mappingDiagnostic.matchedCount,2);assert.equal(error.mappingDiagnostic.candidateCount,2);
    assert.deepEqual(error.mappingDiagnostic.candidates,[{name:'Rede TV',qualities:['uhd','hd']},{name:'Rede TV',qualities:['uhd','hd']}]);
    assert.doesNotMatch(JSON.stringify(error.mappingDiagnostic),/private-one|private-two|https|secret/);return true;
  });
});

test('an exact channel label wins over a separate codec-labelled identity without mixing variants',()=>{
  const standard=channel('standard','Hbo Plus',['SD','HD','FHD']),encoded=channel('encoded','Hbo Plus H265',['FHD']);
  for(const rows of [[standard,encoded],[encoded,standard]]){
    const f=fixture(rows),matches=resolveWplayWebLiveItems(live('467','HBO Plus'),f.client,f.catalog);
    assert.deepEqual(matches.map(match=>match.sourceId),['standard','standard','standard']);
    assert.deepEqual(matches.map(match=>match.quality),['SD','HD','FHD']);
    assert.equal(initialWplayWebMatch(live('467','HBO Plus'),matches).quality,'FHD');
    const encodedMatches=resolveWplayWebLiveItems(live('468','HBO Plus H265 FHD'),f.client,f.catalog);
    assert.equal(encodedMatches.length,1);assert.equal(encodedMatches[0].sourceId,'encoded');
  }
});

test('codec label preference cannot resolve duplicate exact identities or override explicit native identity',()=>{
  const rows=[channel('standard-one','Hbo Plus'),channel('standard-two','HBO Plus'),channel('encoded','Hbo Plus H265')];
  const ambiguous=fixture(rows);
  assert.throws(()=>resolveWplayWebLiveItems(live('467','HBO Plus'),ambiguous.client,ambiguous.catalog),{code:'WPLAY_WEB_CHANNEL_AMBIGUOUS'});
  const explicit=fixture([rows[0],{...rows[2],nativeChannelId:467}]);
  assert.ok(resolveWplayWebLiveItems(live('467','HBO Plus'),explicit.client,explicit.catalog).every(match=>match.sourceId==='encoded'));
});

test('a unique delivery-labelled channel remains usable when the provider has no exact label',()=>{
  const f=fixture([channel('encoded','Canal sintético H265',['FHD'])]);
  const matches=resolveWplayWebLiveItems(live('469','Canal sintético'),f.client,f.catalog);
  assert.equal(matches.length,1);assert.equal(matches[0].sourceId,'encoded');
});

test('variant quality suffixes do not replace the raw channel title when preferring an exact identity',()=>{
  const f=fixture([channel('standard','HBO Plus',['HD','FHD H265']),channel('encoded','HBO Plus H265',['FHD'])]);
  assert.ok(resolveWplayWebLiveItems(live('467','HBO Plus'),f.client,f.catalog).every(match=>match.sourceId==='standard'));
});

test('codec collision source inventory starts at FHD and explicit HD or SD stays in the exact identity',async()=>{
  const f=fixture([channel('encoded','Hbo Plus H265',['FHD']),channel('standard','Hbo Plus',['SD','HD','FHD'])]),selected=[];
  f.client.sourceURL=value=>new URL(value);
  f.client.playbackURL=async(_kind,id,options)=>{
    const raw=f.client.rawItems.get(`live:${id}`),item=f.catalog.items.find(item=>item.id===id);
    selected.push({rawId:raw.id,name:item.name,exactVariant:options.exactVariant});return new URL(raw.playbackUrl);
  };
  const transport=new WplayWebPlayback({}, {createClient:()=>f.client}),item=live('467','HBO Plus');
  try{
    const inventory=await transport.sources(item);
    assert.equal(inventory.sources.length,3);assert.ok(inventory.sources.every(source=>source.available));
    assert.equal(inventory.sources.find(source=>source.id===inventory.selectedSourceId).quality,'FHD');
    await transport.start(item);
    for(const quality of ['HD','SD'])await transport.start(item,{sourceId:inventory.sources.find(source=>source.quality===quality).id});
    assert.deepEqual(selected,[
      {rawId:'standard',name:'Hbo Plus FHD',exactVariant:true},
      {rawId:'standard',name:'Hbo Plus HD',exactVariant:true},
      {rawId:'standard',name:'Hbo Plus SD',exactVariant:true}
    ]);
  }finally{await transport.close();}
});

test('explicit shared native ID wins without leaking OTT identity or granting a title alias',()=>{
  const f=fixture([{...channel('opaque-secret','Record News'),nativeChannelId:543},channel('opaque-other','Record News')]);
  const matches=resolveWplayWebLiveItems(live('543','Record TV News'),f.client,f.catalog);
  assert.ok(matches.length>0);assert.ok(matches.every(match=>match.sourceId==='opaque-secret'));
});

test('initial source ranks declared dimensions before quality labels and ignores legacy HD default',()=>{
  const hd={quality:'HD',qualityKey:'hd',metadata:{height:720}},fhd={quality:'FHD',qualityKey:'fhd',metadata:{height:1080}},fourK={quality:'4K',qualityKey:'uhd',metadata:{height:2160}};
  assert.equal(initialWplayWebMatch(live('1','Channel HD'),[hd,fhd,fourK],{nativeItem:{subTitle:'HD'}}),fourK);
  const misleading={quality:'4K',qualityKey:'uhd',metadata:{height:576}};
  assert.equal(initialWplayWebMatch(live('1','Channel'),[misleading,fhd,hd]),fhd);
  assert.equal(initialWplayWebMatch(live('1','Channel'),[]),null);
});

test('sources and start share a 30s diagnostic throttle per native channel and code',async()=>{
  const f=fixture([channel('private-one','Record News')]),reports=[];let now=100000;
  const transport=new WplayWebPlayback({}, {createClient:()=>f.client,onDiagnostic:diagnostic=>reports.push(diagnostic),now:()=>now});
  try{
    await assert.rejects(transport.sources(live('543','Record TV News')),{code:'WPLAY_WEB_CHANNEL_NOT_FOUND'});
    await assert.rejects(transport.start(live('543','Record TV News')),{code:'WPLAY_WEB_CHANNEL_NOT_FOUND'});
    assert.equal(reports.length,1);
    now+=29999;await assert.rejects(transport.sources(live('543','Record TV News')));assert.equal(reports.length,1);
    now++;await assert.rejects(transport.sources(live('543','Record TV News')));assert.equal(reports.length,2);
    await assert.rejects(transport.sources(live('544','Record TV News')));assert.equal(reports.length,3);
    assert.doesNotMatch(JSON.stringify(reports),/private|secret|https/);
  }finally{await transport.close();}
});
