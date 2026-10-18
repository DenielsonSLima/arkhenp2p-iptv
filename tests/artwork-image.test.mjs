import test from 'node:test';
import assert from 'node:assert/strict';
import {bindArtworkImage,retryArtworkImages} from '../web/artwork-image.js';

const source='/api/shared-image/'+'a'.repeat(64);
const classes=()=>{const values=new Set();return {add:value=>values.add(value),remove:value=>values.delete(value),contains:value=>values.has(value)};};
class Picture extends EventTarget{
  constructor(){super();this.classList=classes();this.parentElement={classList:classes(),hidden:false};this.ownerDocument={hidden:false};this.style={removeProperty:name=>delete this.style[name]};this.isConnected=true;this.sources=[];}
  closest(){return this.parentElement.hidden?this.parentElement:null;}
  set src(value){this.sources.push(value);}
  get src(){return this.sources.at(-1);}
}
const root=picture=>({querySelectorAll:()=>picture.classList.contains('image-failed')?[picture]:[]});

test('a cloud reconnect may renew exhausted image attempts while normal retries remain bounded',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const picture=new Picture();let failures=0;
  bindArtworkImage(picture,{source,onFailure:()=>failures++});
  picture.dispatchEvent(new Event('error'));
  for(const delay of [2000,6000,6000]){t.mock.timers.tick(delay);picture.dispatchEvent(new Event('error'));}
  assert.equal(picture.sources.length,4);assert.equal(failures,1);
  assert.equal(retryArtworkImages(root(picture)),0);t.mock.timers.tick(10000);assert.equal(picture.sources.length,4);
  assert.equal(retryArtworkImages(root(picture),{resetBudget:true}),1);t.mock.timers.tick(0);assert.equal(picture.sources.length,5);
  picture.dispatchEvent(new Event('load'));assert.equal(picture.classList.contains('image-failed'),false);assert.equal(picture.style.display,undefined);
});

test('reconnect retries cannot renew images owned by a retired account scope',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const picture=new Picture();let scope='account-a';
  bindArtworkImage(picture,{source,getScope:()=>scope});picture.dispatchEvent(new Event('error'));scope='account-b';
  assert.equal(retryArtworkImages(root(picture),{resetBudget:true}),0);t.mock.timers.tick(10000);assert.equal(picture.sources.length,1);
});

test('a pending retry cannot request hidden catalog artwork and resumes without renewing its budget',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const picture=new Picture();
  bindArtworkImage(picture,{source});picture.dispatchEvent(new Event('error'));
  picture.parentElement.hidden=true;t.mock.timers.tick(2000);
  assert.equal(picture.sources.length,1,'A connected image inside hidden application must not retry.');
  assert.equal(retryArtworkImages(root(picture)),0);t.mock.timers.tick(20000);assert.equal(picture.sources.length,1);
  picture.parentElement.hidden=false;assert.equal(retryArtworkImages(root(picture)),1);t.mock.timers.tick(0);
  assert.match(picture.src,/artwork_retry=1$/);
  for(const delay of [6000,6000]){picture.dispatchEvent(new Event('error'));t.mock.timers.tick(delay);}
  picture.dispatchEvent(new Event('error'));assert.equal(retryArtworkImages(root(picture)),0);assert.equal(picture.sources.length,4);
});

test('a fallback and failure callback are deferred while hidden and remain recoverable on return',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const picture=new Picture();let failures=0;
  bindArtworkImage(picture,{source:'/assets/channels/synthetic-aaaaaaaa.webp',fallback:source,onFailure:()=>failures++});
  picture.parentElement.hidden=true;picture.dispatchEvent(new Event('error'));
  assert.equal(picture.sources.length,1);assert.equal(failures,0);
  assert.equal(retryArtworkImages(root(picture),{resetBudget:true}),0);
  picture.parentElement.hidden=false;assert.equal(retryArtworkImages(root(picture)),1);t.mock.timers.tick(0);
  assert.equal(picture.src,source);assert.equal(failures,0);
  picture.dispatchEvent(new Event('load'));assert.equal(picture.classList.contains('image-failed'),false);
});

test('a hidden browser document never retries and an account change prevents deferred recovery',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const picture=new Picture();let scope='a';
  bindArtworkImage(picture,{source,getScope:()=>scope});picture.dispatchEvent(new Event('error'));picture.ownerDocument.hidden=true;
  t.mock.timers.tick(2000);assert.equal(picture.sources.length,1);
  assert.equal(retryArtworkImages(root(picture),{resetBudget:true}),0);
  scope='b';picture.ownerDocument.hidden=false;assert.equal(retryArtworkImages(root(picture)),0);
  t.mock.timers.tick(10000);assert.equal(picture.sources.length,1);
});
