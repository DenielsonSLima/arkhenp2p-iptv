import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsTools} from '../web/settings-tools.js';

class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.dataset={};this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,handler){this.listeners[name]=handler;}
}
function fixture(t,groups=[]){
  const before=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{if(before===undefined)delete globalThis.document;else globalThis.document=before;});
  let saved=0;
  const settings=Object.assign(Object.create(SettingsTools.prototype),{type:'movies',groups,trash:[],editing:null,query:'',onlyFavorites:false,options:{getFavorites:()=>new Map(),toast:()=>{}},persist:()=>saved++,render:()=>{}});
  const container=new Element('div'),render=()=>{container.replaceChildren();settings.renderPersonalGroups(container,{items:[]});};render();
  const all=()=>{const output=[];const walk=node=>{output.push(node);for(const child of node.children||[])walk(child);};walk(container);return output;};
  return {settings,container,all,render,saved:()=>saved};
}

test('settings expose no new category creation while preserving an empty account',t=>{
  const state=fixture(t);
  assert.equal(state.all().some(node=>/Criar categoria|Nome da nova categoria/.test(node.textContent||node.attributes?.['aria-label']||'')),false);
  assert.equal(state.all().some(node=>node.tagName==='form'),false);
  assert.equal(state.settings.groups.length,0);assert.equal(state.saved(),0);
});

test('existing personal categories remain editable without any create action or destructive migration',t=>{
  const group={id:'saved',name:'Minha coleção',type:'movies',itemKeys:['movie:1']},state=fixture(t,[group]);
  state.all().find(node=>node.className==='settings-group-open').listeners.click();state.render();
  assert.equal(state.settings.groups[0],group);assert.deepEqual(group.itemKeys,['movie:1']);
  assert.equal(state.all().some(node=>node.textContent==='Criar categoria'),false);
  const input=state.all().find(node=>node.attributes['aria-label']==='Renomear grupo'),form=state.all().find(node=>node.tagName==='form');
  assert.ok(input&&form);input.value='Coleção preservada';form.listeners.submit({preventDefault(){}});
  assert.equal(group.name,'Coleção preservada');assert.equal(state.saved(),1);assert.deepEqual(group.itemKeys,['movie:1']);
});
