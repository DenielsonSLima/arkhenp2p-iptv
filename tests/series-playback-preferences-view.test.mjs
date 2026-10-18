import test from 'node:test';
import assert from 'node:assert/strict';
import {SeriesPlaybackPreferences} from '../web/series-playback-preferences.js';
import {SERIES_AUTOPLAY_CHOICES,renderSeriesPlaybackPreferences,seriesPlaybackSummary} from '../web/sistema/configuracoes/series.js';
import {SETTINGS_SECTIONS} from '../web/sistema/configuracoes/views.js';
import {SettingsTools} from '../web/sistema/configuracoes/orquestrador.js';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.classes=new Set();this.classList={toggle:(key,value)=>value?this.classes.add(key):this.classes.delete(key)};}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,run){this.listeners[key]=run;}
}
function view(t,{controller=new SeriesPlaybackPreferences({storage:null})}={}){
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const container=new Element('div'),messages=[],dispose=renderSeriesPlaybackPreferences(container,{controller,toast:text=>messages.push(text)});
  t.after(dispose);const section=container.children[0];
  return {controller,section,messages,dispose,checks:section.children.filter(child=>child.className==='settings-series-toggle').map(child=>child.children[0]),
    options:section.children.find(child=>child.className==='settings-series-options').children.filter(child=>child.tagName==='label'),
    seconds:section.children.find(child=>child.className==='settings-series-offset').children[1].children[0],
    summary:section.children.find(child=>child.className==='settings-series-summary')};
}

test('series automation has a distinct settings route and the three honestly labeled timing policies',t=>{
  assert.equal(SETTINGS_SECTIONS.find(section=>section.id==='series-playback').label,'Reprodução de séries');
  assert.deepEqual(SERIES_AUTOPLAY_CHOICES.map(choice=>choice.mode),['offset','markers','ended']);
  const previous=globalThis.location;globalThis.location={hash:'#settings/series-playback'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const calls=[];SettingsTools.prototype.restoreRoute.call({open:(...args)=>calls.push(args)});assert.deepEqual(calls,[['series-playback',undefined,false]]);
});

test('the default waits for credits markers and keeps approximate timing opt-in',t=>{
  const f=view(t);assert.equal(f.checks[0].checked,true);assert.equal(f.checks[1].checked,true);assert.equal(f.seconds.value,'30');
  assert.equal(f.options[1].children[0].checked,true);assert.equal(f.seconds.disabled,true);
  assert.match(f.summary.textContent,/quando o episódio terminar/);
  assert.match(seriesPlaybackSummary({autoNext:true,nextMode:'offset',endOffsetSeconds:30}),/aproximado.*pode incluir cenas/);
  assert.match(f.section.children.filter(child=>child.className==='settings-series-toggle')[1].children[1].children[1].textContent,/5 segundos.*cancelar ou pular agora/);
  assert.match(seriesPlaybackSummary({autoNext:true,nextMode:'markers'}),/quando o episódio terminar/);
});

test('controls update a shared preference instance in place and disabling autoplay disables timing fields',t=>{
  const f=view(t),originalFieldset=f.section.children.find(child=>child.tagName==='fieldset');
  f.checks[0].checked=false;f.checks[0].listeners.change();assert.equal(f.controller.getPreferences().autoNext,false);
  assert.ok(f.options.every(row=>row.children[0].disabled));assert.equal(f.seconds.disabled,true);assert.match(f.summary.textContent,/iniciado por você/);
  f.controller.setPreferences({autoNext:true,nextMode:'ended'});assert.equal(f.options[2].children[0].checked,true);assert.equal(f.seconds.disabled,true);
  assert.equal(f.section.children.find(child=>child.tagName==='fieldset'),originalFieldset);
  f.options[0].children[0].checked=true;f.options[0].children[0].listeners.change();assert.equal(f.controller.getPreferences().nextMode,'offset');assert.equal(f.seconds.disabled,false);
  f.checks[1].checked=false;f.checks[1].listeners.change();assert.equal(f.controller.getPreferences().autoSkipOpening,false);
});

test('offset input validates real integer bounds and describes the saved approximation',t=>{
  const f=view(t);f.controller.setPreferences({nextMode:'offset'});f.seconds.value='45';f.seconds.listeners.change();assert.equal(f.controller.getPreferences().endOffsetSeconds,45);assert.match(f.summary.textContent,/45 segundos/);
  for(const invalid of ['0','301','1.5','abc']){f.seconds.value=invalid;f.seconds.listeners.change();assert.equal(f.seconds.value,'45');}
  assert.equal(f.messages.length,4);
});

test('subscription disposal prevents detached controls from continuing to receive live changes',t=>{
  const f=view(t);f.dispose();f.controller.setPreferences({autoNext:false});assert.equal(f.checks[0].checked,true);
});

test('closing settings also unsubscribes the series preferences renderer',()=>{
  let disposed=0;const tools={seriesPlaybackCleanup:()=>disposed++,isOpen:true,diagnosticRequest:0,dialog:{},options:{},previousTitle:'Catálogo'};
  const previous=globalThis.document;globalThis.document={querySelector:()=>({})};
  try{SettingsTools.prototype.close.call(tools,false);}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
  assert.equal(disposed,1);assert.equal(tools.seriesPlaybackCleanup,null);
});
