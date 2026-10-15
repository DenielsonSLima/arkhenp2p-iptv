import test from 'node:test';
import assert from 'node:assert/strict';
import {ImmersivePlayer, channelNeighbors, numberedChannels} from '../web/immersive-player.js';

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
    reveal:()=>revealed.push(true),switchChannel:entry=>switched.push(entry),navigateChannel:ImmersivePlayer.prototype.navigateChannel};
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

function attributeNode() {return {attributes:{},setAttribute(name,value){this.attributes[name]=value;}};}

test('neighbor cards expose real numbers and names without starting playback while rendering', () => {
  const view=playerHarness(),classes=new Set();
  view.player.info={classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}};
  view.player.channelNeighborNodes=Object.fromEntries([['previous','Canal anterior'],['next','Próximo canal']].map(([side,label])=>[side,{label,button:attributeNode(),number:attributeNode(),name:attributeNode()}]));
  ImmersivePlayer.prototype.renderChannelNeighbors.call(view.player);
  const previous=view.player.channelNeighborNodes.previous,next=view.player.channelNeighborNodes.next;
  assert.ok(classes.has('ip-live-information'));
  assert.equal(previous.number.textContent,'003');assert.equal(previous.name.textContent,'Canal 10');
  assert.equal(next.number.textContent,'024');assert.equal(next.name.textContent,'Canal 30');
  assert.equal(next.button.attributes['aria-label'],'Próximo canal: 024, Canal 30');
  assert.equal(next.button.disabled,false);assert.equal(view.switched.length,0);
  view.player.channelEntries=()=>[entries[1]];
  ImmersivePlayer.prototype.renderChannelNeighbors.call(view.player);
  assert.equal(previous.button.disabled,true);assert.equal(next.button.disabled,true);assert.equal(next.number.textContent,'');
  view.player.current={item:{kind:'movie',id:'42',name:'Filme'}};
  ImmersivePlayer.prototype.renderChannelNeighbors.call(view.player);
  assert.equal(classes.has('ip-live-information'),false);assert.equal(previous.button.hidden,true);assert.equal(next.button.hidden,true);
});
