import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyGames, gameChannels, gameDisplay, gamesDate } from '../web/daily-games.js';

const NOW=Date.parse('2026-10-14T15:00:00Z');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const game=(extra={})=>({id:'match-1',title:'Time A × Time B',league:{id:'1',name:'Campeonato real',logo:''},start:'2026-10-14T18:30:00Z',status:'scheduled',homeTeam:{id:'1',name:'Time A',logo:''},awayTeam:{id:'2',name:'Time B',logo:''},score:'',channels:[{id:'10',name:'Nome recebido'}],...extra});
const answer=(games=[game()],extra={})=>({available:true,date:'2026-10-14',timeZone:'America/Maceio',games,...extra});
function clock(){let now=NOW,serial=0;const jobs=new Map();return {now:()=>now,schedule:(fn,delay)=>{const id=++serial;jobs.set(id,{fn,at:now+delay});return id;},cancel:id=>jobs.delete(id),jobs,
  async advance(ms){const end=now+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;jobs.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();}};}
function fixture({request=async()=>answer(),document=null,supportsGames=()=>true}={}) {
  const time=clock(),calls=[],updates=[],watched=[];let namespace='wplay:account:1',channels=[{id:'10',kind:'live',name:'Canal real'}];
  const daily=new DailyGames({...time,document,supportsGames,timeZone:'America/Maceio',getNamespace:()=>namespace,getChannels:()=>channels,onWatch:item=>watched.push(item),onUpdate:state=>updates.push(state),request:(url,options)=>{calls.push({url,...options});return request(url,options);}});
  return {daily,time,calls,updates,watched,setNamespace:value=>{namespace=value;},setChannels:value=>{channels=value;}};
}

test('date and kickoff respect the requested zone and never interpret an ambiguous provider time',()=>{
  assert.equal(gamesDate(Date.parse('2026-10-15T01:00:00Z'),'America/Maceio'),'2026-10-14');
  assert.equal(gameDisplay(game(),{timeZone:'America/Maceio'}).kickoff,'15:30');
  assert.equal(gameDisplay(game({start:'2026-10-14 18:30:00'})).kickoff,'Horário não informado');
  assert.equal(gameDisplay(game({start:null})).kickoff,'Horário não informado');
  assert.equal(gameDisplay(game({status:'LIVE',score:'2 - 1'})).status,'Ao vivo');
  assert.equal(gameDisplay(game({status:'LIVE'})).live,true);
  assert.equal(gameDisplay(game({status:'scheduled'})).live,false);
});

test('watching requires exact real live IDs and never guesses a channel from a matching name',()=>{
  const channels=[{id:'10',kind:'live',name:'Canal do catálogo'},{id:'11',kind:'movie',name:'Nome recebido'},{id:'12',kind:'live',name:'Mesmo nome'}];
  assert.deepEqual(gameChannels(game({channels:[{id:'10',name:'Outro nome'},{id:'10'}, {id:'11'}]}),channels).map(item=>item.id),['10']);
  assert.deepEqual(gameChannels(game({channels:[{id:'99',name:'Mesmo nome'}]}),channels),[]);
  assert.deepEqual(gameChannels(game(),[{item:channels[0],number:3}]),[channels[0]]);
});

test('repeated category renders share one pending request and a fresh namespace cache',async()=>{
  const pending=deferred(),f=fixture({request:()=>pending.promise});
  const initial=f.daily.start(),renderedAgain=f.daily.start();assert.equal(initial,renderedAgain);await flush();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/games?date=2026-10-14&timezone=America%2FMaceio&lang=pt');
  pending.resolve(answer());await initial;assert.equal(f.daily.state.status,'ready');
  f.daily.stop();await f.daily.start();assert.equal(f.calls.length,1);f.daily.stop();assert.equal(f.time.jobs.size,0);
});

test('cache expires automatically after a minute and stopping the module cancels all refresh work',async()=>{
  const f=fixture();await f.daily.start();assert.equal(f.calls.length,1);
  await f.time.advance(60000);assert.equal(f.calls.length,2);assert.equal(f.daily.state.status,'ready');
  f.daily.stop();assert.equal(f.time.jobs.size,0);await f.time.advance(120000);assert.equal(f.calls.length,2);
});

test('reset aborts pending requests and neither old responses nor namespaces can repopulate a new account',async()=>{
  const first=deferred(),second=deferred();let count=0;const f=fixture({request:()=>++count===1?first.promise:second.promise});
  const old=f.daily.start();await flush();f.setNamespace('wplay:account:2');f.daily.reset();
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.daily.active,false);
  const next=f.daily.start();await flush();second.resolve(answer([game({id:'new',title:'Conta nova'})]));await next;
  const updates=f.updates.length;first.resolve(answer([game({title:'Conta antiga'})]));await old;
  assert.equal(f.daily.state.data.games[0].title,'Conta nova');assert.equal(f.updates.length,updates);assert.equal(f.daily.cache.size,1);
  f.daily.stop();
});

test('a namespace change alone revokes late data before another section starts',async()=>{
  const pending=deferred(),f=fixture({request:()=>pending.promise});const task=f.daily.start();await flush();f.setNamespace('new-account');
  pending.resolve(answer());await task;assert.equal(f.daily.cache.size,0);assert.equal(f.daily.state.data,null);f.daily.stop();
});

test('temporary failures show a safe message, retain a real cached schedule, and retry automatically',async()=>{
  let calls=0;const f=fixture({request:async()=>{if(++calls===2)throw new Error('https://private.example/token=secret');return answer();}});
  await f.daily.start();await f.time.advance(60000);
  assert.equal(f.daily.state.status,'error');assert.equal(f.daily.state.data.games.length,1);assert.doesNotMatch(f.daily.state.error,/secret|private/);
  await f.time.advance(30000);assert.equal(calls,3);assert.equal(f.daily.state.status,'ready');f.daily.stop();
});

test('an older server capability reports the required update without requests, retries or repeated callbacks',async()=>{
  let supported=false;const f=fixture({document:doc,supportsGames:()=>supported});f.daily.getSection();
  await f.daily.start();assert.equal(f.calls.length,0);assert.equal(f.time.jobs.size,0);
  assert.equal(f.daily.state.status,'unavailable');assert.equal(f.daily.state.reason,'server-update-required');
  assert.equal(find(f.daily.getSection(),'daily-games-message')[0].textContent,'A agenda precisa da atualização do servidor local. Reinicie o servidor para ativar.');
  assert.equal(find(f.daily.getSection(),'daily-games-retry')[0].hidden,true);
  const updates=f.updates.length;await f.daily.start();assert.equal(f.updates.length,updates);
  f.daily.stop();await f.time.advance(120000);assert.equal(f.calls.length,0);assert.equal(f.updates.length,updates);
  supported=true;await f.daily.start();assert.equal(f.calls.length,1);assert.equal(f.daily.state.status,'ready');f.daily.stop();
});

test('a missing route or expired session stops polling and gives a distinct safe action',async()=>{
  for(const [status,reason,message]of [[404,'server-update-required',/Reinicie o servidor/],[401,'session-required',/Entre novamente/]]) {
    const f=fixture({document:doc,request:async()=>{throw Object.assign(new Error('https://private.example/?token=secret'),{status});}});
    f.daily.getSection();await f.daily.start();assert.equal(f.calls.length,1);assert.equal(f.daily.state.reason,reason);
    assert.equal(f.daily.state.status,'unavailable');assert.match(f.daily.state.error,message);assert.doesNotMatch(f.daily.state.error,/private|secret/);
    assert.equal(f.time.jobs.size,0);assert.equal(find(f.daily.getSection(),'daily-games-retry')[0].hidden,true);
    await f.daily.start();await f.daily.refresh();assert.equal(f.calls.length,1);
    f.daily.stop();const updates=f.updates.length;await f.time.advance(120000);assert.equal(f.updates.length,updates);
    f.setNamespace('new-session');f.daily.reset();await f.daily.start();assert.equal(f.calls.length,2);f.daily.stop();
  }
});

test('a provider schedule failure remains retryable without showing an upstream URL or account data',async()=>{
  const f=fixture({request:async()=>{throw Object.assign(new Error('https://private.example/?token=secret'),{status:502,code:'WPLAY_GAMES_UNAVAILABLE'});}});
  await f.daily.start();assert.equal(f.daily.state.status,'error');assert.equal(f.daily.state.error,'O serviço de jogos está indisponível agora. Tente novamente.');
  assert.doesNotMatch(f.daily.state.error,/private|secret/);await f.time.advance(30000);assert.equal(f.calls.length,2);f.daily.stop();
});

test('late failures from a stopped section never publish an error or restart polling',async()=>{
  const pending=deferred(),f=fixture({request:()=>pending.promise});const task=f.daily.start();await flush();f.daily.stop();const updates=f.updates.length;
  pending.reject(Object.assign(new Error('Session expired'),{status:401}));await task;
  assert.equal(f.updates.length,updates);assert.equal(f.daily.blockedReason,'');assert.equal(f.time.jobs.size,0);
});

test('an unsupported service and a supported empty day remain distinct without manufactured fixtures',async()=>{
  const unsupported=fixture({request:async()=>answer([game()],{available:false})});await unsupported.daily.start();
  assert.equal(unsupported.daily.state.data.available,false);assert.deepEqual(unsupported.daily.state.data.games,[]);unsupported.daily.stop();
  const empty=fixture({request:async()=>answer([])});await empty.daily.start();assert.equal(empty.daily.state.data.available,true);assert.deepEqual(empty.daily.state.data.games,[]);empty.daily.stop();
});

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.listeners={};this.hidden=false;this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,listener){this.listeners[key]=listener;}
  get nextElementSibling(){const siblings=this.parentElement?.children||[];return siblings[siblings.indexOf(this)+1]||null;}
  insertBefore(child,before){this.insertions=(this.insertions||0)+1;this.children=this.children.filter(item=>item!==child);const index=before?this.children.indexOf(before):-1;if(index<0)this.children.push(child);else this.children.splice(index,0,child);child.parentElement=this;}
}
const doc={createElement:tag=>new Element(tag)};
const find=(element,className)=>[element,...element.children.flatMap(child=>find(child,className))].filter(node=>node.className===className);

test('game cards render the downloaded league and both team crests beside their names',async()=>{
  const logo=letter=>'/api/sports-image/'+letter.repeat(64);
  const f=fixture({document:doc,request:async()=>answer([game({league:{name:'Liga real',logo:logo('a')},homeTeam:{name:'Casa',logo:logo('b')},awayTeam:{name:'Visitante',logo:logo('c')}})])});
  const section=f.daily.getSection();await f.daily.start();
  const league=find(section,'daily-game-league-logo'),teams=find(section,'daily-game-team-logo');
  assert.equal(league.length,1);assert.equal(league[0].src,logo('a'));assert.equal(league[0].width,28);
  assert.deepEqual(teams.map(node=>node.src),[logo('b'),logo('c')]);assert.ok(teams.every(node=>node.width===36&&node.loading==='lazy'));
  assert.equal(find(section,'daily-game-league-name')[0].textContent,'Liga real');
  assert.deepEqual(find(section,'daily-game-team').map(row=>row.children.at(-1).textContent),['Casa','Visitante']);f.daily.stop();
});

test('the section preserves its cards across renders and revalidates channel visibility when clicked',async()=>{
  const f=fixture({document:doc}),container=new Element('div');f.daily.mount(container);await flush();
  const section=f.daily.getSection(),button=find(section,'daily-game-watch')[0],card=find(section,'daily-game')[0];
  assert.equal(button.textContent,'Assistir · Canal real');await f.daily.start();assert.equal(find(section,'daily-game')[0],card);
  button.listeners.click();assert.equal(f.watched[0].id,'10');
  f.setChannels([]);button.listeners.click();assert.equal(f.watched.length,1);assert.equal(find(section,'daily-game-watch').length,0);
  assert.equal(find(section,'daily-game-unmapped')[0].textContent,'Canal não informado');f.daily.stop();
});

test('live renders do not move an already mounted section or disturb its focused subtree',async()=>{
  const f=fixture({document:doc}),container=new Element('div'),layout=new Element('div');container.insertBefore(layout,null);
  const section=f.daily.mount(container,{before:layout});await flush();
  const insertions=container.insertions;f.daily.mount(container,{before:layout});await flush();
  assert.equal(container.insertions,insertions);assert.equal(container.children[0],section);assert.equal(container.children[1],layout);
  const home=new Element('div');f.daily.mount(home);await flush();assert.equal(home.children[0],section);f.daily.stop();
});

test('a section stopped in the same render never dispatches its cancelled request',async()=>{
  const f=fixture({document:doc});f.daily.mount(new Element('div'));f.daily.stop();await flush();
  assert.equal(f.calls.length,0);assert.equal(f.time.jobs.size,0);
  await f.daily.start();assert.equal(f.calls.length,1);f.daily.stop();
});

test('service absence, empty results and malicious-looking labels render only as text with no external logo requests',async()=>{
  const f=fixture({document:doc,request:async()=>answer([game({homeTeam:{name:'<script>bad</script>',logo:'https://outside.example/logo'},awayTeam:{name:'Real',logo:''}})])});
  f.daily.getSection();await f.daily.start();const section=f.daily.getSection();assert.equal(find(section,'daily-game-team')[0].children[0].textContent,'<script>bad</script>');
  assert.equal(find(section,'daily-game-team').flatMap(team=>team.children).some(child=>child.tagName==='img'),false);f.daily.stop();
  for(const [response,message]of [[answer([]),'Nenhum jogo informado para hoje'],[answer([],{available:false}),'Agenda não disponibilizada pelo serviço']]) {
    const view=fixture({document:doc,request:async()=>response});view.daily.getSection();await view.daily.start();assert.equal(find(view.daily.getSection(),'daily-games-message')[0].textContent,message);view.daily.stop();
  }
});

test('team logos from the shared Supabase schedule use the authenticated opaque image route',async()=>{
  const shared='/api/shared-image/'+'a'.repeat(64),f=fixture({document:doc,request:async()=>answer([game({homeTeam:{name:'Time A',logo:shared},awayTeam:{name:'Time B',logo:shared+'?token=x'}})])});
  f.daily.getSection();await f.daily.start();
  const teams=find(f.daily.getSection(),'daily-game-team');
  assert.equal(teams[0].children.find(child=>child.tagName==='img')?.src,shared);
  assert.equal(teams[1].children.some(child=>child.tagName==='img'),false);f.daily.stop();
});

test('default browser timers keep the global receiver required by Safari',async t=>{
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,calls=[];
  globalThis.setTimeout=function(callback,delay){assert.equal(this,globalThis);calls.push(['set',delay]);return calls.length;};
  globalThis.clearTimeout=function(timer){assert.equal(this,globalThis);calls.push(['clear',timer]);};
  t.after(()=>{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;});
  const daily=new DailyGames({request:async()=>answer(),timeZone:'America/Maceio',now:()=>NOW,document:null});await daily.start();daily.stop();
  assert.equal(calls.some(([type,delay])=>type==='set'&&delay===10000),true);assert.equal(calls.some(([type,delay])=>type==='set'&&delay===60000),true);
});
