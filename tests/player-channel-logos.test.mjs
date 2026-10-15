import test from 'node:test';
import assert from 'node:assert/strict';
import {playerChannelLogoSources,renderPlayerChannelLogo} from '../web/player-channel-logos.js';

const local='/assets/channels/sportv-1234abcd.webp',remote='/api/image?ref=fixture';
const channel={kind:'live',id:'1',name:'Canal',poster:local,posterOriginal:remote};
class Element extends EventTarget {
  constructor(){super();this.children=[];this.hidden=false;this.ownerDocument={createElement:()=>new Element()};}
  replaceChildren(){this.children=[];}
  append(child){this.children.push(child);}
  setAttribute(){}
  removeAttribute(name){delete this[name];}
}
test('channel logos use only validated service/local images and never movie artwork or external URLs',()=>{
  assert.deepEqual(playerChannelLogoSources(channel),[local,remote]);
  assert.deepEqual(playerChannelLogoSources({...channel,poster:remote,posterOriginal:remote}),[remote]);
  assert.deepEqual(playerChannelLogoSources({...channel,kind:'movie'}),[]);
  for(const poster of ['https://example.com/logo.png','javascript:alert(1)','//example.com/a','/assets/other.svg'])assert.deepEqual(playerChannelLogoSources({kind:'live',poster}),[]);
});
test('broken local artwork falls back once to the original proxy and then hides the decorative slot',()=>{
  const container=new Element();assert.equal(renderPlayerChannelLogo(container,channel),true);
  const image=container.children[0];assert.equal(image.src,local);assert.equal(image.alt,'');
  image.dispatchEvent(new Event('error'));assert.equal(image.src,remote);assert.equal(container.hidden,false);
  image.dispatchEvent(new Event('error'));assert.equal(container.hidden,true);assert.equal(image.src,undefined);
  renderPlayerChannelLogo(container,channel);assert.equal(container.hidden,true,'Repeated renders must not loop failed image requests.');
});
test('stale image errors cannot replace a new channel and channels without artwork retain their text elsewhere',()=>{
  const container=new Element();renderPlayerChannelLogo(container,channel);const old=container.children[0];
  renderPlayerChannelLogo(container,{...channel,id:'2',poster:remote,posterOriginal:''});const next=container.children[0];
  old.dispatchEvent(new Event('error'));assert.equal(next.src,remote);assert.equal(container.hidden,false);
  renderPlayerChannelLogo(container,{kind:'live',id:'3',name:'Sem logo'});assert.equal(container.hidden,true);assert.equal(container.children.length,0);
});
