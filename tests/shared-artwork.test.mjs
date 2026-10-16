import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {sanitizeSharedCatalog} from '../lib/shared-cache-worker.mjs';
import {artworkURL,fallbackArtworkURL} from '../web/channel-artwork.js';
import {episodeArtworkSources} from '../web/series-preview.js';
import {playerChannelLogoSources} from '../web/player-channel-logos.js';
import {openingArtwork,preloadArtwork} from '../web/login/capas.js';
import {withoutSessionArtwork} from '../web/stored-artwork.js';

test('shared catalog images survive normalization, player logos, episode fallback and opening preparation',async()=>{
  const runtime=new CloudRuntime(),client={images:new Map([['cover','https://images.example/cover.jpg?token=private']])};
  const context={client,providerKey:'a'.repeat(64),scopeHash:'b'.repeat(64)};
  const data=sanitizeSharedCatalog({categories:[{id:'1',name:'Séries'}],items:[{kind:'series',id:'1',name:'Série',categoryId:'1',poster:'/api/image?ref=cover',backdrop:'/api/image?ref=cover'}]},
    {type:'series',mapImage:value=>runtime.registerImage(value,context)});
  const raw=data.items[0],item={...raw,poster:artworkURL(raw.poster)},shared=item.poster;
  assert.match(shared,/^\/api\/shared-image\/[a-f0-9]{64}$/);
  assert.doesNotMatch(shared,/token|private|images\.example/);
  assert.deepEqual(episodeArtworkSources({},item),[{url:shared,kind:'series'}]);
  assert.deepEqual(playerChannelLogoSources({...item,kind:'live'}),[shared]);
  assert.equal(fallbackArtworkURL('/assets/channels/channel-12345678.webp',shared),shared);
  const opening=openingArtwork({shelves:[{items:[item]}]});assert.deepEqual(opening,[shared]);
  const requested=[],createImage=()=>({decode:async()=>{},set src(value){requested.push(value);queueMicrotask(()=>this.onload?.());}});
  assert.deepEqual(await preloadArtwork(opening,{createImage}),{completed:1,loaded:1,total:1});
  assert.deepEqual(requested,[shared]);
  // Persisted title snapshots still discard authenticated proxy references.
  assert.equal(withoutSessionArtwork(item).poster,'');runtime.close();
});

test('shared artwork accepts only the exact opaque route served by the backend',()=>{
  const shared='/api/shared-image/'+'a'.repeat(64);
  for(const value of [shared+'?token=x',shared+'#x',shared+'/',shared.toUpperCase(),'/api/shared-image?ref='+'a'.repeat(64),'/api/shared-image/'+'a'.repeat(63),'/api/shared-image/'+'a'.repeat(65),'/api/shared-image/%2e%2e/private','https://example.com'+shared]){
    assert.equal(artworkURL(value),'');
    assert.equal(fallbackArtworkURL('/assets/channels/channel-12345678.webp',value),'');
  }
  assert.equal(fallbackArtworkURL(shared,shared),'');
});
