import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutSessionArtwork } from '../web/stored-artwork.js';

test('saved titles keep metadata and bundled logos, never authenticated artwork references',()=>{
  const title={id:'309206683028',kind:'series',name:'Série',poster:'/api/image?ref=old-cover',backdrop:'/api/image?ref=old-scene',year:'2026',rating:8.2};
  const before=structuredClone(title),saved=withoutSessionArtwork(title);
  assert.deepEqual(saved,{...title,poster:'',backdrop:''});
  assert.deepEqual(title,before);
  const logo='/assets/channels/sportv-abcdef12.webp';
  assert.deepEqual(withoutSessionArtwork({id:'42',poster:logo,posterOriginal:'/api/image?ref=old-logo'}),{id:'42',poster:logo,posterOriginal:''});
});

test('invalid and external stored artwork cannot become a fallback in a new session',()=>{
  for(const poster of ['https://example.com/account.jpg','/assets/channels/../../private','/api/image?ref=old',null])assert.equal(withoutSessionArtwork({poster}).poster,'');
  assert.deepEqual(withoutSessionArtwork({id:'1',name:'Sem capa'}),{id:'1',name:'Sem capa'});
});
