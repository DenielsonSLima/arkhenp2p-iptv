import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_CHOICES,audioStatusMessage,renderAudioPreferences} from '../web/sistema/configuracoes/audio.js';
import {SETTINGS_SECTIONS} from '../web/sistema/configuracoes/views.js';
import {SettingsTools} from '../web/sistema/configuracoes/orquestrador.js';

test('audio settings have a dedicated route and the three distinct listening modes', t => {
  assert.equal(SETTINGS_SECTIONS.find(section => section.id === 'audio')?.label, 'Áudio');
  assert.deepEqual(AUDIO_CHOICES.map(choice => choice.mode), ['original', 'balanced', 'night']);
  const previous = globalThis.location;
  globalThis.location = {hash:'#settings/audio'};
  t.after(() => {if (previous === undefined) delete globalThis.location;else globalThis.location = previous;});
  const calls = [];
  SettingsTools.prototype.restoreRoute.call({open:(...args) => calls.push(args)});
  assert.deepEqual(calls, [['audio', undefined, false]]);
});

test('audio status distinguishes actual processing from saved preferences and safe fallback', () => {
  assert.match(audioStatusMessage({state:'active'}, {mode:'balanced'}), /Equilibrado ativo/);
  assert.match(audioStatusMessage({state:'active'}, {mode:'night'}), /Noturno ativo/);
  assert.match(audioStatusMessage({state:'idle'}, {mode:'balanced'}), /será aplicada durante a reprodução/);
  assert.match(audioStatusMessage({state:'suspended'}, {mode:'night'}), /iniciar ou retomar/);
  assert.match(audioStatusMessage({state:'suspended'}, {mode:'original'}), /áudio aguarda uma interação/);
  for (const state of ['error', 'bypassed']) assert.match(audioStatusMessage({state}, {mode:'balanced'}), /áudio original será mantido/);
  assert.match(audioStatusMessage({state:'unsupported'}, {mode:'balanced'}), /Proteção automática indisponível/);
  assert.match(audioStatusMessage({state:'unsupported'}, {mode:'balanced'}), /volume por canal continua disponível quando suportado/);
  assert.match(audioStatusMessage({state:'active'}, {mode:'original'}), /Áudio original selecionado/);
});

class Element {
  constructor(tag) {this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.listeners={};this.classes=new Set();this.classList={toggle:(name,on) => on ? this.classes.add(name) : this.classes.delete(name)};}
  append(...children) {this.children.push(...children);}
  setAttribute(name, value) {this.attributes[name]=value;}
  addEventListener(name, handler) {this.listeners[name]=handler;}
}
function useDocument(t) {
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  return new Element('div');
}

test('changing a mode updates preferences and live status in place, then disposes its subscription', async t => {
  const container=useDocument(t),listeners=new Set(),calls=[];
  let preferences={mode:'balanced'},status={state:'idle'},unsubscribed=0;
  const activated=[];
  const controller={getPreferences:()=>preferences,getStatus:()=>status,requestActivation:()=>activated.push(preferences.mode),
    setPreferences:value=>{calls.push(value);preferences=value;for(const listener of listeners)listener();},
    subscribe:listener=>{listeners.add(listener);return()=>{unsubscribed++;listeners.delete(listener);}}};
  const dispose=renderAudioPreferences(container,{controller});
  const section=container.children[0],fieldset=section.children.find(child=>child.tagName==='fieldset'),rows=fieldset.children.filter(child=>child.tagName==='label');
  const message=section.children.find(child=>child.attributes.role==='status');
  assert.equal(rows[1].children[0].checked,true);
  const radio=rows[2].children[0];radio.checked=true;await radio.listeners.change();
  assert.deepEqual(calls,[{mode:'night'}]);
  assert.deepEqual(activated,['night']);
  assert.equal(rows[1].children[0].checked,false);assert.equal(radio.checked,true);
  status={state:'active'};for(const listener of listeners)listener();
  assert.match(message.textContent,/Noturno ativo/);
  assert.equal(section.children.find(child=>child.tagName==='fieldset'),fieldset,'Engine updates preserve the existing controls and their focus.');
  const original=rows[0].children[0];original.checked=true;await original.listeners.change();
  assert.deepEqual(activated,['night','original'],'Original can resume an already captured, suspended context.');
  dispose();assert.equal(unsubscribed,1);assert.equal(listeners.size,0);
});

test('an unavailable controller preserves original playback and disables inactive choices', t => {
  const container=useDocument(t),dispose=renderAudioPreferences(container);
  const section=container.children[0],fieldset=section.children.find(child=>child.tagName==='fieldset');
  const inputs=fieldset.children.filter(child=>child.tagName==='label').map(row=>row.children[0]);
  assert.equal(inputs[0].checked,true);assert.ok(inputs.every(input=>input.disabled));
  assert.match(section.children.find(child=>child.attributes.role==='status').textContent,/indisponível/);
  dispose();
});

test('per-channel volume is enabled by default and updates independently from the protection preset', async t => {
  const container=useDocument(t),calls=[];let preferences={mode:'balanced'},activated=0;
  const controller={getPreferences:()=>preferences,getStatus:()=>({state:'idle'}),
    requestActivation:()=>activated++,setPreferences:patch=>{calls.push(patch);preferences={...preferences,...patch};}};
  const dispose=renderAudioPreferences(container,{controller});
  const memory=container.children[0].children.find(child=>child.className==='settings-audio-memory'),checkbox=memory.children[0];
  assert.equal(checkbox.checked,true);
  checkbox.checked=false;await checkbox.listeners.change();
  assert.deepEqual(calls,[{rememberChannelVolume:false}]);assert.equal(preferences.mode,'balanced');assert.equal(activated,0);
  dispose();
});

test('settings unsubscribe audio updates when closing settings', () => {
  let disposed=0;
  const tools={audioCleanup:()=>{disposed++;},isOpen:true,diagnosticRequest:0,dialog:{},options:{onClose(){}},previousTitle:'Catálogo'};
  const previous=globalThis.document;
  globalThis.document={querySelector:()=>({})};
  try {SettingsTools.prototype.close.call(tools,false);}
  finally {if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
  assert.equal(disposed,1);assert.equal(tools.audioCleanup,null);assert.equal(tools.isOpen,false);
});
