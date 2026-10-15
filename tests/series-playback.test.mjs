import test from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeSkipController, EpisodeSkipStore, nextEpisodeTrigger} from '../web/episode-skip.js';
import {SeriesPlaybackPreferences, SERIES_PLAYBACK_DEFAULTS, normalizeSeriesPlaybackPreferences} from '../web/series-playback-preferences.js';
import {EpisodeMarkerCatalog} from '../web/series-markers/index.js';

const namespace='a'.repeat(64);
const storage=()=>{const values=new Map();return {values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};};
class Element extends EventTarget {
  constructor(tag){super();this.tagName=tag;this.children=[];this.textContent='';this.hidden=false;this.attributes={};}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  remove(){this.removed=true;}
}
const document={createElement:tag=>new Element(tag)};
function clock(){let now=1000,serial=0;const timers=new Map();return {now:()=>now,timers,schedule:(run,delay)=>{const id=++serial;timers.set(id,{at:now+delay,run});return id;},cancel:id=>timers.delete(id),
  advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].run();}now=end;}};}
function fixture({values={},onSeek,getEpisodeMarkers,readyState=4}={}){
  const time=clock(),browserStorage=storage(),preferences=new SeriesPlaybackPreferences({storage:browserStorage}),video=new EventTarget(),next=[],notifications=[];
  Object.assign(video,{duration:600,currentTime:0,paused:false,ended:false,readyState,error:null});preferences.setPreferences(values);let account=namespace;
  const controller=new EpisodeSkipController({video,document,storage:browserStorage,preferences,getNamespace:()=>account,onSeek,getEpisodeMarkers,...time,onNextEpisode:options=>next.push(options),hasNextEpisode:()=>true,notify:message=>notifications.push(message)});
  const attach=(episode='episode_1',source='source-one')=>controller.attach({item:{kind:'series',id:'show_1'},episode:{id:episode},sourceFingerprint:source});attach();
  return {time,video,controller,preferences,browserStorage,next,notifications,attach,event:name=>video.dispatchEvent(new Event(name)),at(value){video.currentTime=value;video.dispatchEvent(new Event('timeupdate'));},account(value){account=value;}};
}

test('defaults are automatic, a clearly configured 30 second fallback and marked openings only',()=>{
  const preferences=new SeriesPlaybackPreferences({storage:storage()});assert.deepEqual(preferences.getPreferences(),SERIES_PLAYBACK_DEFAULTS);
  assert.deepEqual(nextEpisodeTrigger({},600,preferences.getPreferences()),{at:570,reason:'offset',approximate:true});
  assert.deepEqual(nextEpisodeTrigger({creditsStart:555},600,preferences.getPreferences()),{at:555,reason:'credits',approximate:false});
  assert.deepEqual(nextEpisodeTrigger({},30,preferences.getPreferences()),{at:30,reason:'ended',approximate:false});
  assert.equal(nextEpisodeTrigger({},600,{autoNext:false}),null);
});

test('preference persistence validates mode, flags and limits and notifies one live instance',()=>{
  const browserStorage=storage(),preferences=new SeriesPlaybackPreferences({storage:browserStorage}),changes=[];
  const unsubscribe=preferences.subscribe(value=>changes.push(value));preferences.setPreferences({autoNext:false,nextMode:'ended',endOffsetSeconds:45});
  assert.equal(changes.length,1);assert.equal(new SeriesPlaybackPreferences({storage:browserStorage}).getPreferences().autoNext,false);
  assert.deepEqual(normalizeSeriesPlaybackPreferences({autoNext:'false',autoSkipOpening:0,nextMode:'fake',endOffsetSeconds:9000}),SERIES_PLAYBACK_DEFAULTS);
  const copy=preferences.getPreferences();copy.autoNext=true;assert.equal(preferences.getPreferences().autoNext,false);unsubscribe();preferences.setPreferences({autoNext:true});assert.equal(changes.length,1);
});

test('the default countdown runs for five seconds once, includes its approximation, and ignores duplicate ended',()=>{
  const f=fixture();f.at(569.99);assert.equal(f.controller.countdownPanel.hidden,true);f.at(570);
  assert.match(f.controller.countdownTitle.textContent,/5s/);assert.match(f.controller.countdownDetail.textContent,/aproximado/);
  f.time.advance(4999);assert.equal(f.next.length,0);f.time.advance(1);
  assert.deepEqual(f.next,[{automatic:true,reason:'credits',approximate:true}]);
  f.video.ended=true;f.event('ended');f.event('ended');f.time.advance(10000);assert.equal(f.next.length,1);f.controller.destroy();
});

test('pause and buffering suspend the countdown clock until playing resumes',()=>{
  const f=fixture();f.at(570);f.time.advance(2000);f.video.paused=true;f.event('pause');
  assert.match(f.controller.countdownTitle.textContent,/pausada.*3s/);f.time.advance(60000);assert.equal(f.next.length,0);
  f.video.paused=false;f.event('playing');f.time.advance(1000);f.event('waiting');f.time.advance(10000);assert.equal(f.next.length,0);
  f.event('playing');f.time.advance(1999);assert.equal(f.next.length,0);f.time.advance(1);assert.equal(f.next.length,1);f.controller.destroy();
});

test('seeked cannot resume the next-episode clock while playback is still stalled',()=>{
  const f=fixture();f.at(570);f.time.advance(1000);
  f.video.seeking=true;f.video.readyState=1;f.event('seeking');f.event('waiting');
  f.video.seeking=false;f.event('seeked');f.time.advance(15000);
  assert.equal(f.next.length,0);assert.match(f.controller.countdownTitle.textContent,/pausada.*4s/);
  f.video.readyState=4;f.event('seeked');f.event('timeupdate');f.time.advance(15000);
  assert.equal(f.next.length,0,'Metadata and seeked alone do not confirm resumed decoding.');
  f.event('playing');f.time.advance(3999);assert.equal(f.next.length,0);f.time.advance(1);
  assert.equal(f.next.length,1);f.controller.destroy();
});

test('automatic actions also require decoded data and never run during an unfinished seek',()=>{
  const seeks=[],f=fixture({onSeek:target=>{seeks.push(target);return true;}});
  f.at(10);f.controller.mark('openingStart');f.at(40);f.controller.mark('openingEnd');
  f.video.readyState=1;f.at(20);assert.equal(seeks.length,0);
  f.video.readyState=4;f.video.seeking=true;f.event('playing');assert.equal(seeks.length,0);
  f.video.seeking=false;f.event('playing');f.time.advance(4999);assert.equal(seeks.length,0);f.time.advance(1);assert.deepEqual(seeks,[40]);
  f.at(570);f.time.advance(1000);f.video.readyState=1;f.event('timeupdate');f.time.advance(15000);
  assert.equal(f.next.length,0);assert.match(f.controller.countdownTitle.textContent,/pausada.*4s/);
  f.video.readyState=4;f.event('playing');f.time.advance(4000);assert.equal(f.next.length,1);f.controller.destroy();
});

test('cancel remains effective for this episode including ended, and seeking before the trigger rearms it',()=>{
  const f=fixture();f.at(570);assert.equal(f.controller.cancelAutoNext(),true);f.at(590);f.time.advance(10000);assert.equal(f.next.length,0);
  f.preferences.setPreferences({autoSkipOpening:false});f.time.advance(10000);assert.equal(f.next.length,0,'An unrelated preference must not undo cancellation.');
  f.video.currentTime=600;f.video.ended=true;f.event('ended');f.time.advance(10000);assert.equal(f.next.length,0);
  f.video.ended=false;f.at(500);f.event('playing');f.at(570);f.time.advance(5000);assert.equal(f.next.length,1);f.controller.destroy();
});

test('a pending opening seek from an old source cannot change state or report errors for its replacement',async()=>{
  let reject;const pending=new Promise((resolve,no)=>{reject=no;});const f=fixture({onSeek:()=>pending});
  f.at(10);f.controller.mark('openingStart');f.at(40);f.controller.mark('openingEnd');f.at(20);f.time.advance(5000);assert.equal(f.controller.openingPending,true);
  f.video.currentTime=0;f.attach('episode_2','source-two');reject(new Error('old source'));await Promise.resolve();
  assert.equal(f.controller.openingPending,false);assert.equal(f.notifications.length,0);assert.equal(f.controller.context.episodeId,'episode_2');f.controller.destroy();
});

test('the ended mode preserves the full episode; marker-only mode falls back to its actual end',()=>{
  for(const nextMode of ['ended','markers']){
    const f=fixture({values:{nextMode}});f.at(599);assert.equal(f.controller.countdownPanel.hidden,true);
    f.video.currentTime=600;f.video.ended=true;f.video.paused=true;f.event('ended');assert.match(f.controller.countdownDetail.textContent,/concluído/);
    f.time.advance(5000);assert.deepEqual(f.next,[{automatic:true,reason:'ended',approximate:false}]);f.controller.destroy();
  }
});

test('trusted episode credits override the approximate offset and a manual action cannot double-advance',()=>{
  const f=fixture();f.at(550);f.controller.mark('creditsStart');assert.equal(f.controller.countdown.reason,'credits');
  assert.match(f.controller.countdownDetail.textContent,/Créditos marcados/);assert.equal(f.controller.skipCredits(),true);
  assert.deepEqual(f.next,[{automatic:false,reason:'credits',approximate:false}]);f.time.advance(10000);f.event('ended');assert.equal(f.next.length,1);f.controller.destroy();
});

test('a compatible imported post-credit policy preserves final content instead of using the default 30-second offset',async()=>{
  const catalog=new EpisodeMarkerCatalog({request:async()=>({schemaVersion:1,dataVersion:'post-credits-test',series:{slug:'game-of-thrones',tmdbId:1399,imdbId:'tt0944947'},records:[{season:1,episode:1,edition:{id:'community-post-credits',durationSeconds:600,toleranceSeconds:2},verification:{status:'community-reference',blockEarlyNext:true},markers:{},sources:[{url:'https://skipdb.tv/docs',title:'SkipDB'}]}]})});
  const metadata=await catalog.lookup({item:{kind:'series',name:'Game of Thrones'},episode:{season:1,number:1},duration:600,allowReferenceMarkers:true});assert.equal(metadata.status,'matched');
  const f=fixture({getEpisodeMarkers:()=>metadata});f.at(570);f.time.advance(20000);assert.equal(f.next.length,0);assert.equal(f.controller.countdownPanel.hidden,true);assert.match(f.controller.catalogSource.textContent,/preservar conteúdo final/);
  f.at(599.9);f.time.advance(10000);assert.equal(f.next.length,0,'The player cannot guess that final scenes have ended.');
  f.video.currentTime=600;f.video.ended=true;f.video.paused=true;f.event('ended');assert.match(f.controller.countdownTitle.textContent,/5s/);assert.match(f.controller.countdownDetail.textContent,/preservar conteúdo final/);
  f.time.advance(4999);assert.equal(f.next.length,0);f.time.advance(1);assert.deepEqual(f.next,[{automatic:true,reason:'ended',approximate:false}]);f.controller.destroy();
});

test('an explicit manual credits marker overrides the imported preserve-final policy and clearing it restores protection',()=>{
  const f=fixture({getEpisodeMarkers:()=>({status:'matched',markers:{creditsStart:500},blockEarlyNext:true,confidence:'community-reference'})});
  f.at(550);assert.equal(f.controller.state().marks.creditsStart,undefined,'An ambiguous imported credits boundary is not offered as a real window.');assert.equal(f.controller.countdownPanel.hidden,true);
  assert.equal(f.controller.mark('creditsStart'),true);assert.equal(f.controller.state().blockEarlyNext,false);assert.equal(f.controller.countdown.reason,'credits');
  f.time.advance(2000);f.controller.clear();assert.equal(f.controller.state().blockEarlyNext,true);assert.equal(f.controller.countdownPanel.hidden,true);f.time.advance(10000);assert.equal(f.next.length,0);
  f.at(560);f.controller.mark('creditsStart');f.time.advance(5000);assert.deepEqual(f.next,[{automatic:true,reason:'credits',approximate:false}]);f.controller.destroy();
});

test('automatic openings count down visibly for five seconds before using the central seek callback',()=>{
  const seeks=[],f=fixture({onSeek:(target,options)=>{seeks.push({target,options});f.video.currentTime=target;return true;}});
  f.at(20);assert.equal(seeks.length,0);f.at(10);f.controller.mark('openingStart');f.at(40);f.controller.mark('openingEnd');
  f.at(20);assert.equal(seeks.length,0);assert.equal(f.controller.openingButton.hidden,true);assert.equal(f.controller.openingCountdownPanel.hidden,false);
  for(const seconds of [5,4,3,2,1]){assert.equal(f.controller.openingCountdownTitle.textContent,`Pular abertura em ${seconds}s`);f.time.advance(1000);}
  assert.deepEqual(seeks,[{target:40,options:{reason:'opening'}}]);assert.equal(f.video.currentTime,40);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  f.at(20);assert.equal(seeks.length,1,'A seek back lets the user watch the opening instead of skipping repeatedly.');f.controller.destroy();
});

test('the opening countdown pauses during buffering and seek, and requires playing to resume',()=>{
  const seeks=[],f=fixture({getEpisodeMarkers:()=>({marks:{openingStart:10,openingEnd:60}}),onSeek:target=>{seeks.push(target);return true;}});
  f.at(10);f.time.advance(2000);f.event('waiting');f.time.advance(10000);
  assert.equal(seeks.length,0);assert.match(f.controller.openingCountdownTitle.textContent,/pausada.*3s/);
  f.video.seeking=true;f.event('seeking');f.video.seeking=false;f.event('seeked');f.time.advance(10000);assert.equal(seeks.length,0);
  f.event('playing');f.time.advance(2999);assert.equal(seeks.length,0);f.time.advance(1);assert.deepEqual(seeks,[60]);f.controller.destroy();
});

test('cancelling an opening survives updates and unrelated settings, and rearms only before the opening',()=>{
  const seeks=[],f=fixture({getEpisodeMarkers:()=>({marks:{openingStart:10,openingEnd:60}}),onSeek:target=>{seeks.push(target);return true;}});
  f.at(10);f.time.advance(1000);assert.equal(f.controller.cancelAutoOpening(),true);assert.equal(f.controller.openingCountdownPanel.hidden,true);assert.equal(f.controller.openingButton.hidden,false);
  f.preferences.setPreferences({endOffsetSeconds:45});f.at(30);f.time.advance(10000);assert.equal(seeks.length,0);
  f.at(65);f.at(20);f.time.advance(10000);assert.equal(seeks.length,0);
  f.at(0);f.at(10);f.time.advance(5000);assert.deepEqual(seeks,[60]);f.controller.destroy();
});

test('the explicit opening action skips immediately and reset revokes an old countdown callback',()=>{
  const seeks=[],f=fixture({getEpisodeMarkers:()=>({marks:{openingStart:10,openingEnd:60}}),onSeek:target=>{seeks.push(target);return true;}});
  f.at(10);const stale=[...f.time.timers.values()][0].run;
  f.controller.skipOpeningNowButton.dispatchEvent(new Event('click'));assert.deepEqual(seeks,[60]);f.time.advance(10000);assert.equal(seeks.length,1);
  f.video.currentTime=0;f.attach('episode_2','new-source');stale();f.time.advance(10000);assert.equal(seeks.length,1);assert.equal(f.controller.openingCountdownPanel.hidden,true);f.controller.destroy();
});

test('late arrival within the last five seconds never creates or rushes an automatic opening skip',()=>{
  const seeks=[],f=fixture({getEpisodeMarkers:()=>({marks:{openingStart:10,openingEnd:60}}),onSeek:target=>{seeks.push(target);return true;}});
  f.at(55.1);assert.equal(f.controller.openingCountdownPanel.hidden,true);assert.equal(f.controller.openingButton.hidden,false);f.time.advance(10000);assert.equal(seeks.length,0);
  f.at(60);assert.equal(f.controller.overlay.hidden,true);f.controller.destroy();
});

test('opening cancellation and timers never cross accounts or episode generations',()=>{
  const seeks=[],f=fixture({getEpisodeMarkers:()=>({marks:{openingStart:10,openingEnd:60}}),onSeek:target=>{seeks.push(target);return true;}});
  f.at(10);const stale=[...f.time.timers.values()][0].run;f.account('b'.repeat(64));f.time.advance(10000);
  assert.equal(f.controller.context,null);assert.equal(f.controller.openingCountdownPanel.hidden,true);assert.equal(seeks.length,0);
  f.video.currentTime=10;f.attach('episode_2','source-two');f.controller.cancelAutoOpening();
  f.video.currentTime=10;f.attach('episode_3','source-three');stale();f.time.advance(5000);assert.deepEqual(seeks,[60]);f.controller.destroy();
});

test('validated supplied windows work without manual marks and remain separate from user overrides',()=>{
  const calls=[],f=fixture({getEpisodeMarkers:args=>{calls.push(args);return {marks:{openingStart:10,openingEnd:60,creditsStart:550},source:'fixture exact edition'};}});
  f.at(10);assert.equal(f.controller.openingCountdownPanel.hidden,false);assert.equal(f.controller.store.has(f.controller.context),false);
  assert.deepEqual(calls.at(-1),{item:{kind:'series',id:'show_1'},episode:{id:'episode_1'},duration:600,sourceFingerprint:'source-one'});
  f.controller.cancelAutoOpening();f.at(20);assert.equal(f.controller.mark('openingStart'),true);
  assert.deepEqual(f.controller.state().marks,{openingStart:20,creditsStart:550},'An unfinished manual opening cannot borrow an imported end.');
  f.at(65);f.controller.mark('openingEnd');assert.deepEqual(f.controller.state().marks,{openingStart:20,openingEnd:65,creditsStart:550});
  const manual=f.controller.store.read(f.controller.context,600).marks;assert.deepEqual(manual,{openingStart:20,openingEnd:65});
  f.at(560);f.controller.mark('creditsStart');assert.equal(f.controller.state().marks.creditsStart,560);
  f.controller.clear();assert.deepEqual(f.controller.state().marks,{openingStart:10,openingEnd:60,creditsStart:550});f.controller.destroy();
});

test('malformed or failing optional episode metadata never supplies an invented skip window',()=>{
  for(const getEpisodeMarkers of [()=>({marks:{openingStart:10,openingEnd:700}}),()=>({marks:{openingEnd:60}}),()=>{throw new Error('optional')},()=>Promise.resolve({marks:{openingStart:10,openingEnd:60}})]){
    const f=fixture({getEpisodeMarkers});f.at(20);assert.equal(f.controller.openingCountdownPanel.hidden,true);assert.equal(f.controller.openingButton.hidden,true);f.time.advance(10000);assert.equal(f.next.length,0);f.controller.destroy();
  }
});

test('async catalog windows load once and start a visible five-second opening offer with test provenance',async()=>{
  let resolve,calls=0,signal;const pending=new Promise(done=>resolve=done),seeks=[];
  const f=fixture({getEpisodeMarkers:input=>{calls++;signal=input.signal;return pending;},onSeek:target=>seeks.push(target)});
  f.at(10);f.at(11);assert.equal(calls,1);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  resolve({status:'matched',markers:{openingStart:10,openingEnd:60,creditsStart:550},confidence:'community-reference'});await Promise.resolve();
  assert.equal(f.controller.openingCountdownPanel.hidden,false);assert.match(f.controller.openingCountdownDetail.textContent,/em teste/);
  assert.match(f.controller.openingCountdownTitle.textContent,/5s/);f.time.advance(4999);assert.deepEqual(seeks,[]);f.time.advance(1);assert.deepEqual(seeks,[60]);
  f.controller.destroy();assert.equal(signal.aborted,true);
});

test('async catalog results cannot cross episode, duration or account and inactive references never become marks',async()=>{
  for(const change of [f=>f.attach('other','other-source'),f=>{f.video.duration=800;f.event('durationchange');},f=>f.account('b'.repeat(64))]){
    let resolve,calls=0;const pending=new Promise(done=>resolve=done),f=fixture({getEpisodeMarkers:()=>++calls===1?pending:null});f.at(10);change(f);
    resolve({status:'matched',markers:{openingStart:10,openingEnd:60}});await Promise.resolve();
    assert.equal(f.controller.externalResult,null);assert.equal(f.controller.openingCountdownPanel.hidden,true);f.controller.destroy();
  }
  const f=fixture({getEpisodeMarkers:async()=>({status:'unverified',markers:{openingStart:10,openingEnd:60}})});f.at(10);await Promise.resolve();
  assert.equal(f.controller.openingCountdownPanel.hidden,true);assert.deepEqual(f.controller.state().marks,{});f.controller.destroy();
});

test('disabling automatic playback cancels active work while keeping the manual marked skip available',()=>{
  const f=fixture();f.at(550);f.controller.mark('creditsStart');assert.equal(f.controller.countdownPanel.hidden,false);
  f.preferences.setPreferences({autoNext:false,autoSkipOpening:false});assert.equal(f.controller.countdownPanel.hidden,true);assert.equal(f.controller.creditsButton.hidden,false);
  f.time.advance(10000);f.event('ended');f.time.advance(5000);assert.equal(f.next.length,0);f.controller.destroy();
});

test('source reset and account changes revoke stale timers without applying the old episode work',()=>{
  const f=fixture();f.at(570);const stale=[...f.time.timers.values()][0].run;f.controller.reset();stale();f.time.advance(5000);assert.equal(f.next.length,0);
  f.video.currentTime=0;f.attach('episode_2','source-two');f.at(570);f.account('b'.repeat(64));f.time.advance(5000);
  assert.equal(f.next.length,0);assert.equal(f.controller.context,null);f.controller.destroy();
});

test('automation waits for new media metadata rather than acting on the previous source duration',()=>{
  const f=fixture({readyState:0});f.at(580);assert.equal(f.controller.countdownPanel.hidden,true);f.time.advance(10000);assert.equal(f.next.length,0);
  f.video.readyState=4;f.event('loadedmetadata');f.event('playing');assert.equal(f.controller.countdownPanel.hidden,false);f.controller.destroy();
});

test('marker storage scopes opaque episode IDs by account and source and does not migrate unscoped v1 records',()=>{
  const browserStorage=storage(),store=new EpisodeSkipStore(browserStorage),context={namespace,seriesId:'show_UUID',episodeId:'opaque-episode_ABC',sourceFingerprint:'/api/play/secret?token=never-store'};
  assert.equal(store.save(context,600,{openingStart:10,openingEnd:40}),true);
  assert.deepEqual(new EpisodeSkipStore(browserStorage).read(context,600).marks,{openingStart:10,openingEnd:40});
  assert.deepEqual(store.read({...context,namespace:'b'.repeat(64)},600).marks,{});
  assert.deepEqual(store.read({...context,episodeId:'../unsafe'},600).marks,{});
  const serialized=[...browserStorage.values.values()].join('');assert.doesNotMatch(serialized,/secret|token|never-store/);assert.equal(serialized.includes(namespace),false);
  const legacy=new EpisodeSkipStore({getItem:()=>JSON.stringify({version:1,episodes:[{...context,duration:600,marks:{creditsStart:550}}]})});assert.equal(legacy.records.size,0);
});

test('missing or transient account namespaces keep marks in this session and a retune retains those marks',()=>{
  const browserStorage=storage(),store=new EpisodeSkipStore(browserStorage),context={namespace:'session_42',seriesId:'1',episodeId:'2',sourceFingerprint:'source'};
  assert.equal(store.save(context,600,{creditsStart:550}),false);assert.deepEqual(store.read(context,600).marks,{creditsStart:550});assert.equal(browserStorage.values.size,0);
  assert.deepEqual(new EpisodeSkipStore(browserStorage).read(context,600).marks,{});
  assert.deepEqual(store.read({...context,namespace:'session_43'},600).marks,{});store.clearTransient();assert.equal(store.records.size,0);
  const f=fixture();f.account('session_42');f.attach();f.at(10);f.controller.mark('openingStart');f.at(40);f.controller.mark('openingEnd');f.video.currentTime=0;f.attach();assert.equal(f.controller.state().marks.openingEnd,40);f.controller.destroy();
});
