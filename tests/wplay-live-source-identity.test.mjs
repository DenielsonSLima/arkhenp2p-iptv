import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {liveSourceEntry,liveSourceCatalog,selectLiveSource} from '../lib/wplay/ao-vivo/fontes.mjs';

const address='https://edge-a.example.invalid/live/source.m3u8?token=first&sid=1';
const web=(fields={},channel='81')=>liveSourceEntry(channel,{origin:'web',address,key:'provider-channel',itemId:'variant-fhd',label:'Fonte principal',quality:'FHD',...fields});
const legacyId=(channel,origin,key,url,label)=>({web:'w_',ott:'o_',native:'n_'}[origin]+createHash('sha256').update(JSON.stringify([String(channel),origin,key??'',String(url??''),label])).digest('hex').slice(0,28));

test('web provider item survives token, host and path rotation and selects the current address',()=>{
  const original=web(),rotations=[
    'https://edge-a.example.invalid/live/source.m3u8?token=second&sid=9',
    'https://edge-b.example.invalid/updated/route/index.m3u8?token=third',
  ];
  for(const rotatedAddress of rotations){
    const current=web({address:rotatedAddress});
    assert.match(current.descriptor.id,/^w_[a-f0-9]{28}$/);
    assert.equal(current.descriptor.id,original.descriptor.id);
    assert.equal(selectLiveSource([current],original.descriptor.id),current);
    assert.equal(selectLiveSource([current],original.descriptor.id).address,rotatedAddress);
    assert.deepEqual(liveSourceCatalog('81',[current]),liveSourceCatalog('81',[original]));
    assert.equal(Object.hasOwn(liveSourceCatalog('81',[current]).sources[0],'address'),false);
  }
});

test('web identities distinguish channel, provider item, variant, label and declared quality',()=>{
  const original=web(),alternatives=[
    web({},'82'),
    web({key:'another-provider-channel'}),
    web({itemId:'variant-hd'}),
    web({label:'Fonte alternativa'}),
    web({quality:'HD'}),
  ];
  const ids=[original,...alternatives].map(entry=>entry.descriptor.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(original.descriptor.quality,'FHD');
  assert.equal(alternatives.at(-1).descriptor.quality,'HD');
});

test('native, OTT and incomplete web identities preserve the exact legacy hash',()=>{
  for(const origin of ['native','ott','web']){
    for(const key of [undefined,'provider-channel']){
      const entry=liveSourceEntry('81',{origin,address,key,label:'Fonte principal',quality:'FHD'});
      assert.equal(entry.descriptor.id,legacyId('81',origin,key,address,'Fonte principal'));
    }
  }
  for(const itemId of [undefined,null,'',12]){
    const entry=web({itemId});
    assert.equal(entry.descriptor.id,legacyId('81','web','provider-channel',address,'Fonte principal'));
  }
  for(const key of [undefined,null,'']){
    const entry=web({key});
    assert.equal(entry.descriptor.id,legacyId('81','web',key,address,'Fonte principal'));
  }
});

test('a missing selected source remains a 409 instead of silently choosing a different variant',()=>{
  const available=web(),different=web({itemId:'different-variant'});
  assert.throws(()=>selectLiveSource([available],different.descriptor.id),{code:'LIVE_SOURCE_CHANGED',status:409});
  assert.throws(()=>selectLiveSource([available],'w_'+'0'.repeat(28)),{code:'LIVE_SOURCE_CHANGED',status:409});
});
