import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProfile} from '../web/sistema/configuracoes/views.js';

class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,handler){this.listeners[key]=handler;}
}
function render(t,mediaLibrary){
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const container=new Element('div');let changed=0;
  renderProfile(container,{mediaLibrary,getSession:()=>({account:{}}),onLibraryChange:()=>changed++});
  return {container,changed:()=>changed};
}
test('profile explains unidentified legacy data and imports only after an explicit click',t=>{
  let imports=0;const {container,changed}=render(t,{legacySummary:()=>({available:true,favorites:2,history:1}),importLegacy:()=>{imports++;return {favorites:1,history:1,pending:1};}});
  const section=container.children.find(child=>child.className==='settings-section settings-legacy-library'),[heading,description,button,status]=section.children;
  assert.match(heading.textContent,/Lista anterior/);assert.match(description.textContent,/não identificavam a conta/);assert.match(description.textContent,/copiados para a conta conectada/);
  assert.equal(button.textContent,'Importar lista deste navegador');assert.equal(imports,0);
  button.listeners.click();assert.equal(imports,1);assert.equal(changed(),1);assert.equal(button.disabled,true);assert.match(status.textContent,/demais títulos serão conferidos/);
});
test('profile does not expose an import action without unidentified records',t=>{
  for(const mediaLibrary of [undefined,{legacySummary:()=>({available:false})}]){
    const {container}=render(t,mediaLibrary);assert.equal(container.children.some(child=>child.className==='settings-section settings-legacy-library'),false);
  }
});
