import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewTools } from '../web/preview-tools.js';
import { renderSeriesPreview } from '../web/series-preview.js';
import { renderMoviePreview } from '../web/filmes/previa.js';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.events={};}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,handler){this.events[key]=handler;}
}
function documentFor(t){
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
}

test('failed details expose an explicit retry without starting another request by themselves',t=>{
  documentFor(t);let retries=0;
  const tools=new PreviewTools({icon:()=>new Element('svg'),onRetry:()=>retries++}),summary=new Element('div');
  tools.information(summary,{name:'Série',error:'O serviço não respondeu.'});
  const retry=summary.children.find(child=>child.tagName==='button');
  assert.ok(retry);assert.equal(retries,0);
  assert.equal(summary.children.find(child=>child.className==='detail-error').attributes.role,'alert');
  retry.events.click();assert.equal(retries,1);
  const loaded=new Element('div');tools.information(loaded,{plot:'Sinopse atual.'});
  assert.equal(loaded.children.some(child=>child.tagName==='button'),false);
});

test('a series detail failure is shown as unavailable instead of claiming zero seasons and episodes',t=>{
  documentFor(t);const summary=new Element('div');let enabled,section;
  const tools={begin:()=>({showcase:new Element('div'),summary}),genre:()=>{},actions:(_,options)=>{enabled=options.enabled;},information:()=>{},finish:(_,sections)=>{section=sections[0];}};
  renderSeriesPreview(tools,{name:'Série',error:'HTTP 502',year:2026});
  const facts=summary.children[0];
  assert.deepEqual(facts.children.map(fact=>fact.children[1].textContent),['2026','Indisponível','Indisponível','Sem avaliação']);
  assert.equal(enabled,false);assert.match(section.children[1].textContent,/Tente novamente/);
});

test('a permanently absent title returns to the catalog instead of retrying an invalid identity',t=>{
  documentFor(t);let returned=0,retries=0;
  const tools=new PreviewTools({icon:()=>new Element('svg'),onRetry:()=>retries++,onCatalog:()=>returned++}),summary=new Element('div');
  tools.information(summary,{name:'Título antigo',error:'Título indisponível.',unavailable:true});
  const buttons=summary.children.filter(child=>child.tagName==='button');
  assert.equal(buttons.length,1);assert.equal(buttons[0].children[1].textContent,'Voltar ao catálogo');
  buttons[0].events.click();assert.equal(returned,1);assert.equal(retries,0);
});

test('a permanently absent movie cannot launch a playback known to be unavailable',t=>{
  documentFor(t);let enabled;
  const tools={begin:()=>({showcase:new Element('div'),summary:new Element('div')}),genre:()=>{},actions:(_,options)=>{enabled=options.enabled;},information:()=>{},finish:()=>{}};
  renderMoviePreview(tools,{name:'Removido',unavailable:true});assert.equal(enabled,false);
  renderMoviePreview(tools,{name:'Disponível'});assert.equal(enabled,true);
});
