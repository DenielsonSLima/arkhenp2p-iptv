import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveProgramFeed, parseProgramTime, programWindow} from '../web/program-guide.js';
import {ChannelGuide} from '../web/channel-guide.js';

const NOW=Date.parse('2026-10-14T12:00:00Z');
const program=(title,from,to)=>({title,description:`Sinopse de ${title}`,start:new Date(NOW+from).toISOString(),end:new Date(NOW+to).toISOString()});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){
  let time=NOW,next=0;const timers=new Map();
  return {now:()=>time,schedule:(callback,delay)=>{const id=++next;timers.set(id,{at:time+delay,callback});return id;},cancel:id=>timers.delete(id),
    async advance(duration){const end=time+duration;while(true){const due=[...timers].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].callback();await flush();}time=end;await flush();},get size(){return timers.size;}};
}

test('EPG interprets epoch units and explicit UTC offsets as the same instant',()=>{
  for(const value of [NOW,NOW/1000,String(NOW),String(NOW/1000),'2026-10-14T12:00:00Z','2026-10-14T09:00:00-03:00'])assert.equal(parseProgramTime(value),NOW);
  for(const value of [null,undefined,'','invalid',0])assert.ok(Number.isNaN(parseProgramTime(value)));
});

test('EPG selects by the actual time, preserves descriptions and never labels an expired entry as current',()=>{
  const list=[program('Próximo',60000,120000),program('Anterior',-120000,-60000),program('Agora',-60000,60000),{title:'Inválido',start:'bad',end:'bad'}];
  const result=programWindow(list,NOW);
  assert.equal(result.current.title,'Agora');assert.equal(result.current.description,'Sinopse de Agora');assert.equal(result.previous.title,'Anterior');assert.equal(result.next.title,'Próximo');
  assert.equal(programWindow(list,NOW+60000).current.title,'Próximo');
  assert.equal(programWindow([list[1],list[0]],NOW).current,null);
  assert.equal(programWindow(list,NOW+120000).current,null);
  assert.equal(programWindow(null,NOW).current,null);
});

test('the active channel refreshes at a program boundary and continues with a bounded interval',async()=>{
  const timer=clock(),updates=[];let calls=0;
  const feed=new LiveProgramFeed({...timer,request:async()=>{calls++;return {list:[program('Primeiro',-10000,10000),program('Segundo',10000,200000)]};},onUpdate:data=>updates.push(programWindow(data.list,timer.now()).current?.title)});
  feed.start('123');await flush();assert.equal(calls,1);assert.equal(updates.at(-1),'Primeiro');
  await timer.advance(15000);assert.equal(calls,2);assert.equal(updates.at(-1),'Segundo');
  await timer.advance(45000);assert.equal(calls,2);
  await timer.advance(15000);assert.equal(calls,3);
  feed.stop();assert.equal(timer.size,0);
});

test('a temporary EPG error retains valid data while expired entries disappear naturally',async()=>{
  const timer=clock(),updates=[];let calls=0;
  const feed=new LiveProgramFeed({...timer,request:async()=>{if(++calls>1)throw new Error('temporary');return {list:[program('Atual',-10000,90000)]};},onUpdate:data=>updates.push(programWindow(data.list,timer.now()).current?.title||null)});
  feed.start('123');await flush();await timer.advance(60000);
  assert.equal(calls,2);assert.equal(updates.at(-1),'Atual');
  await timer.advance(30000);assert.equal(calls,3);assert.equal(updates.at(-1),null);
  feed.stop();
});

test('channel switches and closing playback cancel requests and suppress late EPG results',async()=>{
  const timer=clock(),requests=[],updates=[];
  const feed=new LiveProgramFeed({...timer,request:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve})),onUpdate:data=>updates.push(data.list[0]?.title||null)});
  feed.start('123');feed.start('456');assert.equal(requests[0].signal.aborted,true);
  requests[1].resolve({list:[program('Canal novo',-1000,120000)]});await flush();
  requests[0].resolve({list:[program('Canal antigo',-1000,120000)]});await flush();
  assert.equal(updates.at(-1),'Canal novo');assert.equal(updates.includes('Canal antigo'),false);
  feed.stop();assert.equal(requests[1].signal.aborted,true);await timer.advance(120000);assert.equal(requests.length,2);assert.equal(timer.size,0);
});

test('EPG requests have a deadline and retry without overlapping requests',async()=>{
  const timer=clock();let calls=0,active=0,maxActive=0;
  const feed=new LiveProgramFeed({...timer,request:(_,{signal})=>new Promise((resolve,reject)=>{calls++;active++;maxActive=Math.max(maxActive,active);signal.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true});}),onUpdate:()=>{}});
  feed.start('123');await timer.advance(10000);assert.equal(active,0);assert.equal(calls,1);
  await timer.advance(30000);assert.equal(calls,1);
  await timer.advance(5000);assert.equal(calls,2);assert.equal(maxActive,1);
  feed.stop();await flush();assert.equal(active,0);assert.equal(timer.size,0);
});

test('a failed card refresh preserves the current cached guide instead of replacing it with empty data',async()=>{
  const list=[program('Atual',-10000,60000)],job={key:'session:123',controller:new AbortController()},saved=[];
  const guide={api:async()=>{throw new Error('temporary');},isCurrent:()=>true,cache:new Map([[job.key,{list}]]),store:(key,value)=>saved.push({key,list:value}),active:new Map(),pump:()=>{}};
  await ChannelGuide.prototype.fetch.call(guide,job);
  assert.deepEqual(saved,[{key:job.key,list}]);
});
