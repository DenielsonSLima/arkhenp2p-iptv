import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLiveSourceEntries,selectLiveSource} from '../lib/wplay/ao-vivo/fontes.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';

test('identical addresses and quality labels from different channels never share source identifiers',()=>{
  const raw={sources:[{subTitle:'HD',address:'https://synthetic.example/shared.m3u8'}]};
  const record=nativeLiveSourceEntries('446',raw),band=nativeLiveSourceEntries('3',raw);
  assert.notEqual(record[0].descriptor.id,band[0].descriptor.id);
  assert.throws(()=>selectLiveSource(band,record[0].descriptor.id),{code:'LIVE_SOURCE_CHANGED',status:409});
  assert.equal(selectLiveSource(band,band[0].descriptor.id),band[0]);
});

test('a source selected for the previous channel cannot be played for the next channel',async()=>{
  const client=new WplayPlaybackProviderClient({username:'synthetic',password:'synthetic'});
  const items=new Map([['446',{id:'446',kind:'live',name:'Record TV BA'}],['3',{id:'3',kind:'live',name:'BandNews'}]]);
  client.item=async(_type,id)=>items.get(String(id));
  for(const id of items.keys())client.rawItems.set('live:'+id,{sources:[{subTitle:'HD',address:'https://synthetic.example/shared.m3u8'},{subTitle:'SD',address:'https://synthetic.example/shared-sd.m3u8'}]});
  try{
    const record=await client.liveSources('446'),band=await client.liveSources('3');
    assert.equal(record.channelId,'446');assert.equal(band.channelId,'3');
    assert.ok(record.sources.every(source=>!band.sources.some(other=>other.id===source.id)));
    await assert.rejects(()=>client.playbackURL('live','3',null,{attempt:'cross-channel',sourceId:record.selectedSourceId}),{code:'LIVE_SOURCE_CHANGED',status:409});
    const selected=await client.playbackURL('live','3',null,{attempt:'correct-channel',sourceId:band.selectedSourceId});
    assert.equal(selected.pathname,'/shared.m3u8');
  }finally{await client.logout();}
});
