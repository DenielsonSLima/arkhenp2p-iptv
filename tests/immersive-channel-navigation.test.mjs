import test from 'node:test';
import assert from 'node:assert/strict';
import {ImmersivePlayer} from '../web/player/orquestrador.js'
import {TVPlayerNavigation} from '../web/tv/player/navegacao.js';
import {TVPlayerGuide} from '../web/tv/player/grade.js';
import {channelNeighbors, numberedChannels} from '../web/tv/player/canais.js';

const channel = (id, number, name=`Canal ${id}`) => ({number, item:{kind:'live', id:String(id), name}});
const entries = [channel(10,3), channel(20,17), channel(30,24)];
const current = entry => ({item:entry.item, channelNumber:entry.number});

test('channel previews follow the numbered list order and cycle at both ends', () => {
  assert.deepEqual(channelNeighbors(entries,current(entries[1])), {previous:entries[0], current:entries[1], next:entries[2]});
  assert.equal(channelNeighbors(entries,current(entries[0])).previous.item.id,'30');
  assert.equal(channelNeighbors(entries,current(entries[2])).next.item.id,'10');
  const reordered=[entries[2],entries[0],entries[1]];
  assert.equal(channelNeighbors(reordered,current(entries[0])).previous.item.id,'30');
  assert.equal(channelNeighbors(reordered,current(entries[0])).next.item.id,'20');
});

test('unlisted current channels retain the existing first/last selection boundary', () => {
  const neighbors=channelNeighbors(entries,current(channel(99,999)));
  assert.equal(neighbors.current,null);
  assert.equal(neighbors.previous.item.id,'30');
  assert.equal(neighbors.next.item.id,'10');
  assert.equal(channelNeighbors(entries,{item:entries[2].item,channelNumber:3}).current.item.id,'30','Identity takes priority over an outdated number.');
});

test('empty and single-channel lists do not repeat the playing channel as its own neighbor', () => {
  assert.deepEqual(channelNeighbors([],current(entries[0])),{previous:null,current:null,next:null});
  assert.deepEqual(channelNeighbors([entries[0]],current(entries[0])),{previous:null,current:entries[0],next:null});
  const onlyFavorite=channelNeighbors([entries[0]],current(entries[1]));
  assert.equal(onlyFavorite.previous.item.id,'10');assert.equal(onlyFavorite.next.item.id,'10');
  const dirty=[entries[0],channel(10,99),channel(99,3),channel(20,0),{number:1,item:{kind:'movie',id:'1'}},null];
  assert.deepEqual(numberedChannels(dirty),[entries[0]]);
  assert.equal(channelNeighbors(dirty,current(entries[0])).next,null);
});

function playerHarness(selected=entries[1]) {
  const switched=[],revealed=[];
  const player={current:current(selected),tools:{hidden:true,contains:()=>false},keyboardMode:false,blockedByDialog:()=>false,channelEntries:()=>entries,
    typed:{hidden:true},tvGuide:{nodes:[]},reveal:()=>revealed.push(true),switchChannel:entry=>switched.push(entry),navigateChannel:ImmersivePlayer.prototype.navigateChannel};
  player.tvNavigation=new TVPlayerNavigation({getChannels:()=>player.channelEntries(),getCurrent:()=>player.current,onCommit:entry=>player.switchChannel(entry)});
  return {player,switched,revealed};
}
function key(key, extra={}) {
  const event={key,target:{closest:()=>null},prevented:false,preventDefault(){this.prevented=true;},...extra};return event;
}

test('TV remote and keyboard channel commands use exactly the preview neighbors', () => {
  for (const [button,id] of [['ArrowUp','30'],['ChannelUp','30'],['PageUp','30'],['ArrowDown','10'],['ChannelDown','10'],['PageDown','10']]) {
    const view=playerHarness(),event=key(button);
    ImmersivePlayer.prototype.keydown.call(view.player,event);
    assert.equal(event.prevented,true,button);
    assert.deepEqual(view.switched.map(entry=>entry.item.id),[id],button);
  }
  const last=playerHarness(entries[2]);ImmersivePlayer.prototype.keydown.call(last.player,key('ChannelUp'));
  assert.equal(last.switched[0].item.id,'10');
  const first=playerHarness(entries[0]);ImmersivePlayer.prototype.keydown.call(first.player,key('ChannelDown'));
  assert.equal(first.switched[0].item.id,'30');
});

test('channel commands preserve focused inputs, menus, open settings and modal dialogs', () => {
  for (const button of ['ArrowUp','ArrowDown','ChannelUp','ChannelDown','PageUp','PageDown']) {
    for (const mode of ['input','menu','settings','dialog','handled','modifier']) {
      const view=playerHarness(),event=key(button);
      if (mode==='input') event.target.closest=selector=>selector.includes('input') ? {} : null;
      if (mode==='menu') event.target.closest=selector=>selector.includes('[role="menu"]') ? {} : null;
      if (mode==='settings') view.player.tools.hidden=false;
      if (mode==='dialog') view.player.blockedByDialog=()=>true;
      if (mode==='handled') event.defaultPrevented=true;
      if (mode==='modifier') event.ctrlKey=true;
      ImmersivePlayer.prototype.keydown.call(view.player,event);
      assert.equal(event.prevented,false,`${button}: ${mode}`);
      assert.equal(view.switched.length,0,`${button}: ${mode}`);
    }
  }
});

test('modified screenshot keys cannot arm a numbered-channel zap',t=>{
  const scheduled=[];t.mock.method(globalThis,'setTimeout',callback=>{scheduled.push(callback);return 1;});
  for(const modifiers of [{shiftKey:true},{shiftKey:true,metaKey:true},{shiftKey:true,ctrlKey:true}]){
    const view=playerHarness();Object.assign(view.player,{digits:'',typedNumber:{},renderChannelNeighbors:()=>{},commitDigits:()=>view.switched.push('number')});
    const event=key('3',modifiers);ImmersivePlayer.prototype.keydown.call(view.player,event);
    assert.equal(event.prevented,false);assert.equal(view.player.digits,'');
  }
  assert.equal(scheduled.length,0);
});

test('an explicit unmodified channel number still commits the selected numbered channel once',t=>{
  const scheduled=[];t.mock.method(globalThis,'setTimeout',callback=>{scheduled.push(callback);return 1;});
  const view=playerHarness();Object.assign(view.player,{digits:'',typedNumber:{},renderChannelNeighbors:()=>{},commitDigits:ImmersivePlayer.prototype.commitDigits});
  const event=key('3');ImmersivePlayer.prototype.keydown.call(view.player,event);
  assert.equal(event.prevented,true);assert.equal(scheduled.length,1);assert.equal(view.switched.length,0);
  scheduled[0]();assert.deepEqual(view.switched,[entries[0]]);assert.equal(view.player.digits,'');
});

test('the quality notice owns its keyboard interaction without previewing or tuning a channel',t=>{
  const scheduled=[];t.mock.method(globalThis,'setTimeout',callback=>{scheduled.push(callback);return 1;});
  for(const button of ['3','ArrowUp','ArrowRight','Enter',' ']){
    const view=playerHarness();Object.assign(view.player,{digits:'',typedNumber:{},renderChannelNeighbors:()=>{},commitDigits:()=>view.switched.push('number')});
    const event=key(button,{target:{closest:selector=>selector.includes('.tv-quality-notice')?{}:null}});
    ImmersivePlayer.prototype.keydown.call(view.player,event);assert.equal(event.prevented,false);assert.equal(view.switched.length,0);assert.equal(view.player.tvNavigation.previewId,null);
  }
  assert.equal(scheduled.length,0);
});

function attributeNode() {return {attributes:{},setAttribute(name,value){this.attributes[name]=value;}};}

test('TV guide cards expose canonical numbers and names and rendering never tunes media',()=>{
 const view=playerHarness(),classes=new Set(),contexts=[];
 view.player.info={classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}};view.player.tvGuide={setContext:value=>contexts.push(value)};
 ImmersivePlayer.prototype.renderChannelNeighbors.call(view.player);assert.ok(classes.has('ip-live-information'));assert.equal(contexts[0].current,view.player.current);assert.equal(view.switched.length,0);
 const slot=()=>({button:{...attributeNode(),dataset:{}},label:{},number:{},name:{},logo:{replaceChildren(){}},schedule:{},status:{},programs:Object.fromEntries(['previous','current','next'].map(period=>[period,{row:{},title:{},time:{}}]))});
 const guide={navigation:view.player.tvNavigation,current:view.player.current,slots:{previous:slot(),current:slot(),next:slot()},metadata:{start:()=>{},peek:()=>null,status:()=> 'unavailable'}};
 TVPlayerGuide.prototype.render.call(guide);assert.equal(guide.slots.previous.number.textContent,'003');assert.equal(guide.slots.previous.name.textContent,'Canal 10');assert.equal(guide.slots.next.number.textContent,'024');assert.equal(guide.slots.next.button.attributes['aria-label'],'Assistir canal 024, Canal 30');assert.equal(view.switched.length,0);
 guide.programs={window:{current:null},status:'loading'};
 guide.metadata.peek=id=>id==='20'?{window:{current:{title:'Programa atualizado',startLabel:'13:00'}}}:null;
 TVPlayerGuide.prototype.render.call(guide);assert.equal(guide.slots.current.programs.current.title.textContent,'Programa atualizado','The empty opening DTO cannot mask a later shared window.');
 guide.programs={window:{current:{title:'Programa antigo'}}};guide.metadata.peek=id=>id==='20'?{window:{current:null}}:null;
 TVPlayerGuide.prototype.render.call(guide);assert.equal(guide.slots.current.programs.current.row.hidden,true,'An authoritative empty window cannot resurrect the opening programme.');
 view.player.channelEntries=()=>[entries[1]];TVPlayerGuide.prototype.render.call(guide);assert.equal(guide.slots.previous.button.disabled,true);assert.equal(guide.slots.next.button.disabled,true);
 view.player.current={item:{kind:'movie',id:'42',name:'Filme'}};guide.current=view.player.current;ImmersivePlayer.prototype.renderChannelNeighbors.call(view.player);TVPlayerGuide.prototype.render.call(guide);
 assert.equal(classes.has('ip-live-information'),false);assert.equal(guide.slots.previous.button.hidden,true);assert.equal(guide.slots.next.button.hidden,true);
});
