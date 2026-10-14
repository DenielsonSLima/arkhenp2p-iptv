import test from 'node:test';
import assert from 'node:assert/strict';
import {heroArtworkKind, setHeroArtwork, heroFacts} from '../web/home-hero.js';

function artwork() {
  const classes = new Set(), requests = [];
  const element = {children:[],classList:{add:name=>classes.add(name),remove:(...names)=>names.forEach(name=>classes.delete(name))},replaceChildren(...children){this.children=children;}};
  return {element,classes,requests,createImage:()=>{const image={};requests.push(image);return image;}};
}

test('hero only enlarges real high-resolution panoramas and keeps portraits as portraits',()=>{
  assert.equal(heroArtworkKind(1920,1080),'backdrop');
  assert.equal(heroArtworkKind(1280,720),'backdrop');
  assert.equal(heroArtworkKind(500,750),'poster');
  for(const size of [[500,36],[320,180],[640,360],[100,150],[1000,200],[0,0],[NaN,720]])assert.equal(heroArtworkKind(...size),'');
});

test('a low-resolution backdrop falls back to a sharp portrait without a full-screen stretch',()=>{
  const view=artwork();
  setHeroArtwork(view.element,{backdrop:'/api/image?ref=thumb',poster:'/api/image?ref=cover'},view.createImage);
  Object.assign(view.requests[0],{naturalWidth:320,naturalHeight:180});view.requests[0].onload();
  assert.equal(view.element.children.length,0);assert.equal(view.requests.length,2);
  Object.assign(view.requests[1],{naturalWidth:500,naturalHeight:750});view.requests[1].onload();
  assert.equal(view.element.children[0],view.requests[1]);assert.ok(view.classes.has('is-poster'));assert.ok(!view.classes.has('is-backdrop'));
});

test('rapid banner changes ignore stale artwork loads and reuse an unchanged image',()=>{
  const view=artwork(),first={backdrop:'/api/image?ref=a'},second={backdrop:'/api/image?ref=b'};
  setHeroArtwork(view.element,first,view.createImage);setHeroArtwork(view.element,second,view.createImage);
  Object.assign(view.requests[1],{naturalWidth:1280,naturalHeight:720});view.requests[1].onload();
  Object.assign(view.requests[0],{naturalWidth:1920,naturalHeight:1080});view.requests[0].onload();
  assert.equal(view.element.children[0],view.requests[1]);
  setHeroArtwork(view.element,second,view.createImage);assert.equal(view.requests.length,2);
});

test('failed and title-logo-only sources leave the dark banner without unrelated imagery',()=>{
  const view=artwork();setHeroArtwork(view.element,{backdrop:'/api/image?ref=bad',poster:'/api/image?ref=lettering'},view.createImage);
  view.requests[0].onerror();Object.assign(view.requests[1],{naturalWidth:500,naturalHeight:36});view.requests[1].onload();
  assert.equal(view.element.children.length,0);
  setHeroArtwork(view.element,{poster:'https://unregistered.example/a.jpg'},view.createImage);assert.equal(view.requests.length,2);
});

test('banner facts display measured duration and honest missing metadata',()=>{
  const facts=heroFacts({name:'Filme (2026)',rating:8.3,durationSeconds:6983});
  assert.deepEqual(facts.map(fact=>fact.value),['2026','1 h 56 min','8,3 / 10']);
  assert.deepEqual(heroFacts({}).map(fact=>fact.value),['Não informado','Não informada','Sem avaliação']);
  assert.equal(heroFacts({},{durationPending:true})[1].value,'Consultando…');
  assert.equal(heroFacts({},{previousDuration:3600})[1].value,'1 h');
});
