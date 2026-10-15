import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsTools} from '../web/settings-tools.js';

function fixture(t){
  const saved=new Map(),previous=globalThis.localStorage;globalThis.localStorage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)};
  t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;});
  let changes=0;const settings=Object.assign(Object.create(SettingsTools.prototype),{hidden:{},hiddenItems:{},groups:[],channelNumbers:new Map(),startupView:'home',options:{toast:()=>{},onStore:()=>changes++}});
  return {settings,saved,changes:()=>changes};
}

test('switching accounts restores only their own settings and never adopts unidentified global groups',t=>{
  const f=fixture(t),a='a'.repeat(64),b='b'.repeat(64);
  f.saved.set('arkehn.catalog-settings.v1',JSON.stringify({groups:[{id:'legacy',name:'Antiga',type:'movies',itemKeys:['movie:1']}],hidden:{movies:['hidden']}}));
  f.settings.activateAccount(a);assert.deepEqual(f.settings.getCustomGroups(),[]);assert.equal(f.settings.isCategoryVisible('movies','hidden'),true);
  f.settings.setCustomGroups([{id:'own',name:'Da conta A',type:'movies',itemKeys:['movie:2']}]);f.settings.applyPreferences({hidden:{movies:['3']},channelNumbers:{'10':42},startupView:'movies'});
  f.settings.activateAccount(b);assert.deepEqual(f.settings.getCustomGroups(),[]);assert.equal(f.settings.isCategoryVisible('movies','3'),true);assert.equal(f.settings.channelNumbers.size,0);assert.equal(f.settings.getStartupView(),'home');
  f.settings.activateAccount(a);assert.equal(f.settings.getCustomGroups()[0].id,'own');assert.equal(f.settings.isCategoryVisible('movies','3'),false);assert.equal(f.settings.channelNumbers.get('10'),42);assert.equal(f.settings.getStartupView(),'movies');
});

test('remote settings restore without another cloud mutation, while an explicit local store notifies once',t=>{
  const f=fixture(t);f.settings.activateAccount('a'.repeat(64));
  f.settings.applyPreferences({hidden:{live:['1']},channelNumbers:{'1':8,'2':8,'3':10000},startupView:'invalid'});f.settings.setCustomGroups([{id:'valid',name:'Minha lista',type:'series',itemKeys:['series:9','bad']},{id:'invalid',name:'Inválida',type:'other',itemKeys:[]}]);
  assert.equal(f.changes(),0);assert.deepEqual([...f.settings.channelNumbers],[['1',8]]);assert.equal(f.settings.getStartupView(),'home');assert.deepEqual(f.settings.getCustomGroups()[0].itemKeys,['series:9']);assert.equal(f.settings.getCustomGroups().length,1);
  f.settings.store();assert.equal(f.changes(),1);
});
