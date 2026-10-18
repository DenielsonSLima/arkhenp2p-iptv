import test from 'node:test';
import assert from 'node:assert/strict';
import { EpisodeSkipStore, EpisodeSkipController, validateSkipMarkers, activeSkipActions } from '../web/episode-skip.js';
import {SeriesPlaybackPreferences} from '../web/series-playback-preferences.js';

const context = (seriesId = '100', episodeId = '200', sourceFingerprint = '/api/play/series/200.mp4') => ({seriesId, episodeId, sourceFingerprint,namespace:'a'.repeat(64)});
const memoryStorage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values};
};

test('skip actions use only complete, valid manual windows at their exact boundaries', () => {
  const marks = {openingStart: 12.5, openingEnd: 60.25, creditsStart: 540};
  for (const time of [0, 12.49, 60.25, 90]) assert.equal(activeSkipActions(marks, time, 600).opening, false);
  for (const time of [12.5, 40, 60.249]) assert.equal(activeSkipActions(marks, time, 600).opening, true);
  assert.deepEqual(activeSkipActions(marks, 539.99, 600), {opening: false, credits: false});
  assert.deepEqual(activeSkipActions(marks, 540, 600), {opening: false, credits: true});
  assert.deepEqual(activeSkipActions(marks, 600, 600), {opening: false, credits: false});
  assert.equal(activeSkipActions({openingStart: 0}, 0, 600).opening, false);
  assert.equal(activeSkipActions({openingStart: 0, openingEnd: 20}, 0, 600).opening, true);
});

test('invalid, unordered, out-of-bounds and unknown-duration markers cannot produce skip actions', () => {
  for (const marks of [{openingStart: -1}, {openingStart: NaN}, {openingEnd: 20}, {openingStart: 30, openingEnd: 20},
    {openingStart: 10, openingEnd: 10}, {creditsStart: 0}, {creditsStart: 600}, {creditsStart: Infinity},
    {openingStart: 10, openingEnd: 60, creditsStart: 50}, {openingStart: '10'}, []]) {
    assert.equal(validateSkipMarkers(marks, 600), null);
    assert.deepEqual(activeSkipActions(marks, 20, 600), {opening: false, credits: false});
  }
  for (const duration of [0, NaN, Infinity, -1, 90000, '600']) assert.equal(validateSkipMarkers({openingStart: 10}, duration), null);
  for (const time of [-1, NaN, Infinity]) assert.deepEqual(activeSkipActions({creditsStart: 10}, time, 600), {opening: false, credits: false});
});

test('markers persist per exact series and episode without sharing across a series', () => {
  const storage = memoryStorage(), store = new EpisodeSkipStore(storage);
  assert.equal(store.save(context(), 600, {openingStart: 10, openingEnd: 40}), true);
  const restored = new EpisodeSkipStore(storage);
  assert.deepEqual(restored.read(context(), 600).marks, {openingStart: 10, openingEnd: 40});
  assert.deepEqual(restored.read(context('100', '201'), 600).marks, {});
  assert.deepEqual(restored.read(context('101', '200'), 600).marks, {});
  assert.equal(restored.clear(context()), true);
  assert.deepEqual(new EpisodeSkipStore(storage).read(context(), 600).marks, {});
});

test('changed source or duration suppresses old markers until the new edition is marked', () => {
  const store = new EpisodeSkipStore(memoryStorage());
  store.save(context(), 600, {openingStart: 10, openingEnd: 40, creditsStart: 560});
  for (const changed of [context('100', '200', '/api/play/series/200.mkv'), context('100', '200', '/api/play/series/200.mp4?edition=2')]) {
    assert.deepEqual(store.read(changed, 600), {marks: {}, incompatible: true});
  }
  assert.deepEqual(store.read(context(), 605), {marks: {}, incompatible: true});
  assert.deepEqual(store.read(context(), 599.9), {marks: {}, incompatible: true});
  assert.equal(store.save(context(), 605, {openingStart: 15}), true);
  assert.deepEqual(store.read(context(), 605), {marks: {openingStart: 15}, incompatible: false});
  const privateSource = context('100', '202', '/api/play/series/202.mp4?token=private');
  const storage = memoryStorage(); new EpisodeSkipStore(storage).save(privateSource, 600, {openingStart: 10});
  assert.equal([...storage.values.values()][0].includes('private'), false);
});

test('the bounded store retains the latest 200 episodes even when clock values coincide', () => {
  const storage = memoryStorage(), store = new EpisodeSkipStore(storage, () => 1000);
  for (let episode = 1; episode <= 205; episode++) store.save(context('100', String(episode)), 600, {creditsStart: 550});
  assert.equal(store.records.size, 200);
  assert.deepEqual(store.read(context('100', '1'), 600).marks, {});
  assert.deepEqual(store.read(context('100', '205'), 600).marks, {creditsStart: 550});
  assert.equal(new EpisodeSkipStore(storage).records.size, 200);
});

test('corrupt or unavailable browser storage leaves manual marking usable in the current session', () => {
  for (const value of ['invalid JSON', JSON.stringify({version: 2, episodes: []}), JSON.stringify({version: 1, episodes: [{seriesId: '../1', episodeId: '2', source: 'bad', duration: 600, marks: {creditsStart: 20}, updatedAt: 0}]})]) {
    const store = new EpisodeSkipStore({getItem: () => value, setItem() {}}); assert.equal(store.records.size, 0);
  }
  const store = new EpisodeSkipStore({getItem() {throw new Error('blocked');}, setItem() {throw new Error('blocked');}});
  assert.equal(store.save(context(), 600, {openingStart: 5, openingEnd: 40}), false);
  assert.deepEqual(store.read(context(), 600).marks, {openingStart: 5, openingEnd: 40});
  assert.equal(store.clear(context()), false);
  assert.deepEqual(store.read(context(), 600).marks, {});
});

class Element extends EventTarget {
  constructor(tag) {super(); this.tagName = tag; this.children = []; this.textContent = ''; this.hidden = false; this.attributes = new Map();}
  append(...children) {this.children.push(...children);}
  setAttribute(key, value) {this.attributes.set(key, value);}
  remove() {this.removed = true;}
}
const document = {createElement: tag => new Element(tag)};
function controllerFixture(options = {}) {
  const video = new EventTarget(); Object.assign(video, {duration: 600, currentTime: 0, error: null});
  const controller = new EpisodeSkipController({video, document, storage: memoryStorage(), preferences:{getPreferences:()=>({autoSkipOpening:false})}, ...options});
  return {video, controller, attach: () => controller.attach({item: {kind: 'series', id: '100'}, episode: {id: '200'}, sourceFingerprint: '/api/play/series/200.mp4'})};
}

test('community records do not prompt calibration over the video; advanced local marking remains available',()=>{
  let opened=0;
  const f=controllerFixture({getEpisodeMarkers:()=>({status:'matched',markers:{creditsStart:550},confidence:'community-reference'}),onConfigureMarkers:()=>opened++});
  f.attach();assert.equal(f.controller.openingButton.hidden,true);assert.equal(f.controller.configureMarkersButton.hidden,true);
  assert.match(f.controller.catalogAvailability.textContent,/sem marcação conferida/);
  assert.equal(opened,0);assert.equal(f.video.currentTime,0);assert.equal(f.controller.overlay.hidden,true);
  f.video.currentTime=10;f.controller.mark('openingStart');f.video.currentTime=40;f.controller.mark('openingEnd');
  assert.equal(f.controller.configureMarkersButton.hidden,true);assert.equal(f.controller.catalogAvailability.hidden,true);
  f.video.currentTime=20;f.controller.update();assert.equal(f.controller.openingButton.hidden,false);f.controller.destroy();
});

test('incompatible runtimes and failed lookups explain the fallback without making timestamps eligible',async()=>{
  const f=controllerFixture({getEpisodeMarkers:()=>({status:'edition-mismatch',markers:null}),onConfigureMarkers:()=>{}});f.attach();
  assert.match(f.controller.catalogAvailability.textContent,/outra edição/);assert.equal(f.controller.skipOpening(),false);f.controller.destroy();
  const offline=controllerFixture({getEpisodeMarkers:()=>Promise.reject(new Error('Offline')),onConfigureMarkers:()=>{}});offline.attach();
  assert.match(offline.controller.catalogAvailability.textContent,/Buscando/);await Promise.resolve();await Promise.resolve();
  assert.equal(offline.controller.configureMarkersButton.hidden,true);assert.match(offline.controller.catalogAvailability.textContent,/sem marcação conferida/);
  assert.equal(offline.controller.skipOpening(),false);offline.controller.destroy();
});

test('controller requires a series episode, actual metadata and manual marks before exposing actions', () => {
  const {video, controller, attach} = controllerFixture();
  assert.equal(controller.panel.hidden, true);
  controller.attach({item: {kind: 'movie', id: '100'}, episode: {id: '200'}, sourceFingerprint: 'source'});
  assert.equal(controller.panel.hidden, true);
  video.duration = Infinity; attach();
  assert.equal(controller.markerButtons.get('openingStart').disabled, true);
  assert.equal(controller.overlay.hidden, true);
  video.duration = 600; video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(controller.markerButtons.get('openingStart').disabled, false);
  assert.equal(controller.status.textContent, '');
  video.currentTime = 10; assert.equal(controller.mark('openingStart'), true);
  assert.equal(controller.openingButton.hidden, true);
  video.currentTime = 40; assert.equal(controller.mark('openingEnd'), true);
  video.currentTime = 20; video.dispatchEvent(new Event('timeupdate'));
  assert.equal(controller.openingButton.hidden, false);
  assert.equal(controller.skipOpening(), true); assert.equal(video.currentTime, 40); assert.equal(controller.openingButton.hidden, true);
  video.currentTime = 5; assert.equal(controller.skipOpening(), false); assert.equal(video.currentTime, 5);
  controller.destroy();
});

test('credits go to the next episode only after the marked credits start; last episode seeks its actual end', () => {
  let next = 0;
  const fixture = controllerFixture({hasNextEpisode: () => true, onNextEpisode: () => next++}); fixture.attach();
  fixture.video.currentTime = 550; fixture.controller.mark('creditsStart');
  fixture.video.currentTime = 500; assert.equal(fixture.controller.skipCredits(), false); assert.equal(next, 0);
  fixture.video.currentTime = 551; assert.equal(fixture.controller.skipCredits(), true); assert.equal(next, 1);
  fixture.controller.destroy();
  const last = controllerFixture(); last.attach(); last.video.currentTime = 550; last.controller.mark('creditsStart');
  assert.equal(last.controller.skipCredits(), true); assert.equal(last.video.currentTime, 600); assert.equal(last.controller.overlay.hidden, true);
  last.controller.destroy();
});

test('controller resets stale episode actions, ignores changed editions and removes event handlers when destroyed', () => {
  const {video, controller, attach} = controllerFixture(); attach();
  video.currentTime = 10; controller.mark('openingStart'); video.currentTime = 40; controller.mark('openingEnd');
  video.currentTime = 20; controller.update(); assert.equal(controller.openingButton.hidden, false);
  video.duration = 620; video.dispatchEvent(new Event('durationchange'));
  assert.equal(controller.overlay.hidden, true); assert.equal(controller.skipOpening(), false);
  controller.reset(); assert.equal(controller.panel.hidden, true); assert.equal(controller.overlay.hidden, true);
  let updates = 0; controller.update = () => updates++;
  controller.destroy(); video.dispatchEvent(new Event('timeupdate')); assert.equal(updates, 0);
  assert.equal(controller.panel.removed, true); assert.equal(controller.overlay.removed, true);
});

const playableEpisode={item:{kind:'series',id:'100'},episode:{id:'200',season:1,number:1},sourceFingerprint:'logical-edition'};
function publicReference(context,segments={intro:{start:10,end:40,source:'SkipDB'},outro:{start:550,end:600,source:'IntroDB'}}){
  const identity={imdbId:'tt0903747',season:context.episode.season,episode:context.episode.number,duration:context.duration};
  return {status:'reference',markers:null,reference:{schemaVersion:1,...identity,status:'reference',segments},
    binding:{...identity,mediaId:String(context.item.id),episodeId:String(context.episode.id),sourceFingerprint:context.sourceFingerprint}};
}
test('on-demand player waits for playing, deduplicates updates and honors disabled automation',async()=>{
  let count=0,next=0;const f=controllerFixture({requirePlayback:true,getEpisodeMarkers:context=>{count++;assert.equal(context.playing,true);return publicReference(context);},
    hasNextEpisode:()=>true,onNextEpisode:()=>next++,preferences:{getPreferences:()=>({autoSkipOpening:false,autoNext:false})}});
  Object.assign(f.video,{paused:false,readyState:4});f.controller.attach(playableEpisode);
  for(const type of ['loadedmetadata','durationchange','timeupdate'])f.video.dispatchEvent(new Event(type));
  assert.equal(count,0);f.video.currentTime=15;f.video.dispatchEvent(new Event('playing'));assert.equal(count,1);
  for(let i=0;i<10;i++)f.video.dispatchEvent(new Event('timeupdate'));assert.equal(count,1);
  assert.equal(f.controller.openingButton.hidden,false);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  assert.equal(f.video.currentTime,15);assert.deepEqual(f.controller.state().marks,{});
  assert.equal(f.controller.skipOpening(),true);assert.equal(f.video.currentTime,40);
  f.video.currentTime=560;f.controller.update();assert.equal(f.controller.creditsButton.textContent,'Próximo episódio');
  assert.equal(f.controller.countdownPanel.hidden,true);assert.equal(next,0);
  f.controller.skipCredits();assert.equal(next,1);f.controller.destroy();
});

test('credits preserve the API end and explicit post-credit scenes, even if outro extends to file end',()=>{
  for(const explicit of [false,true]){
    let next=0;const parts={outro:{start:550,end:explicit?600:580,source:'IntroDB'},...(explicit?{post_credits:{start:580,end:595,source:'IntroDB'}}:{})};
    const f=controllerFixture({requirePlayback:true,getEpisodeMarkers:context=>publicReference(context,parts),hasNextEpisode:()=>true,onNextEpisode:()=>next++});
    Object.assign(f.video,{paused:false,readyState:4});f.controller.attach(playableEpisode);f.video.dispatchEvent(new Event('playing'));
    f.video.currentTime=560;f.controller.update();assert.equal(f.controller.creditsButton.textContent,'Pular créditos');
    assert.equal(f.controller.skipCredits(),true);assert.equal(f.video.currentTime,580);assert.equal(next,0);
    assert.equal(f.controller.creditsButton.hidden,true);f.controller.destroy();
  }
});

test('switching episode cancels the lookup and ignores its late response',async()=>{
  const jobs=[];const f=controllerFixture({requirePlayback:true,getEpisodeMarkers:context=>new Promise(resolve=>jobs.push({context,resolve}))});
  Object.assign(f.video,{paused:false,readyState:4,currentTime:15});f.controller.attach(playableEpisode);f.video.dispatchEvent(new Event('playing'));
  f.controller.attach({...playableEpisode,episode:{id:'201',season:1,number:2}});assert.equal(jobs[0].context.signal.aborted,true);
  jobs[0].resolve(publicReference(jobs[0].context));await Promise.resolve();assert.equal(f.controller.openingButton.hidden,true);assert.equal(jobs.length,1);
  f.video.dispatchEvent(new Event('playing'));assert.equal(jobs.length,2);
  jobs[1].resolve(publicReference(jobs[1].context));await Promise.resolve();assert.equal(f.controller.openingButton.hidden,false);f.controller.destroy();
});

test('a runtime change while paused discards old references before playback can start a new lookup',()=>{
  let calls=0;const f=controllerFixture({requirePlayback:true,getEpisodeMarkers:context=>{calls++;return publicReference(context);}});
  Object.assign(f.video,{paused:false,readyState:4,currentTime:15});f.controller.attach(playableEpisode);f.video.dispatchEvent(new Event('playing'));
  assert.equal(f.controller.openingButton.hidden,false);f.video.paused=true;f.video.dispatchEvent(new Event('pause'));
  f.video.duration=620;f.video.dispatchEvent(new Event('durationchange'));
  assert.equal(f.controller.openingButton.hidden,true);assert.equal(f.controller.skipOpening(),false);assert.equal(calls,1);
  f.video.paused=false;f.video.dispatchEvent(new Event('playing'));assert.equal(calls,2);f.controller.destroy();
});

test('a foreign episode binding is rejected and manual opening calibration overrides community reference',()=>{
  const f=controllerFixture({getEpisodeMarkers:context=>({...publicReference({...context,episode:{id:'201',season:1,number:2}})})});
  f.controller.attach(playableEpisode);f.video.currentTime=15;f.controller.update();assert.equal(f.controller.skipOpening(),false);f.controller.destroy();
  const manual=controllerFixture({getEpisodeMarkers:publicReference});manual.controller.attach(playableEpisode);
  manual.video.currentTime=15;manual.controller.mark('openingStart');assert.equal(manual.controller.skipOpening(),false);
  manual.video.currentTime=45;manual.controller.mark('openingEnd');manual.video.currentTime=20;
  assert.equal(manual.controller.skipOpening(),true);assert.equal(manual.video.currentTime,45);manual.controller.destroy();
});

function automaticReferenceFixture({segments,hasNext=true,onSeek,getEpisodeMarkers}={}){
  let now=0,serial=0,namespace='a'.repeat(64);const timers=new Map(),next=[],preferences=new SeriesPlaybackPreferences({storage:null});
  const f=controllerFixture({requirePlayback:true,preferences,getNamespace:()=>namespace,
    getEpisodeMarkers:getEpisodeMarkers|| (context=>publicReference(context,segments)),onSeek,
    hasNextEpisode:()=>hasNext,onNextEpisode:options=>next.push(options),now:()=>now,
    schedule:(run,delay)=>{const id=++serial;timers.set(id,{at:now+delay,run});return id;},cancel:id=>timers.delete(id)});
  Object.assign(f.video,{paused:false,seeking:false,readyState:4,ended:false});f.controller.attach(playableEpisode);
  const event=name=>f.video.dispatchEvent(new Event(name));event('playing');
  return {...f,event,next,preferences,timers,account:value=>{namespace=value;},at:value=>{f.video.currentTime=value;event('timeupdate');},
    advance(ms){const end=now+ms;for(;;){const job=[...timers].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!job)break;timers.delete(job[0]);now=job[1].at;job[1].run();}now=end;}};
}

test('community intro and final credits use the default visible five-second countdown exactly once',()=>{
  let calls=0;const f=automaticReferenceFixture({getEpisodeMarkers:context=>{calls++;return publicReference(context);}});
  f.at(10);
  for(const seconds of [5,4,3,2,1]){
    assert.equal(f.controller.openingCountdownTitle.textContent,`Pular abertura em ${seconds}s`);
    assert.equal(f.video.currentTime,10);f.advance(1000);
  }
  assert.equal(f.video.currentTime,40);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  assert.deepEqual(f.controller.state().marks,{},'Automatic use does not turn a reference into verified/manual marks.');
  f.at(550);
  for(const seconds of [5,4,3,2,1]){
    assert.equal(f.controller.countdownTitle.textContent,`Próximo episódio em ${seconds}s`);
    assert.equal(f.next.length,0);f.advance(1000);
  }
  assert.deepEqual(f.next,[{automatic:true,reason:'credits',approximate:false}]);
  f.event('ended');f.advance(15000);assert.equal(f.next.length,1);assert.equal(calls,1);f.controller.destroy();
});

test('automatic credits preserve post-credit content and the last episode seeks its end',()=>{
  for(const explicit of [false,true]){
    const segments={outro:{start:550,end:explicit?600:580,source:'IntroDB'},...(explicit?{post_credits:{start:580,end:595,source:'IntroDB'}}:{})};
    const f=automaticReferenceFixture({segments});f.at(550);
    assert.equal(f.controller.countdownTitle.textContent,'Pular créditos em 5s');
    assert.equal(f.controller.playNextButton.textContent,'Pular agora');
    f.advance(4999);assert.equal(f.video.currentTime,550);f.advance(1);
    assert.equal(f.video.currentTime,580);assert.equal(f.next.length,0);
    f.advance(10000);assert.equal(f.next.length,0);f.controller.destroy();
  }
  const last=automaticReferenceFixture({hasNext:false});last.at(550);last.advance(5000);
  assert.equal(last.video.currentTime,600);assert.equal(last.next.length,0);last.controller.destroy();
});

test('community countdowns pause for pause, buffering and seeking, and resume only on playing',()=>{
  for(const type of ['opening','credits']){
    const f=automaticReferenceFixture();f.at(type==='opening'?10:550);f.advance(2000);
    f.video.paused=true;f.event('pause');f.advance(30000);
    f.video.paused=false;f.event('playing');f.advance(1000);f.event('waiting');f.advance(30000);
    f.video.seeking=true;f.event('seeking');f.video.seeking=false;f.event('seeked');f.advance(30000);
    assert.equal(f.video.currentTime,type==='opening'?10:550);assert.equal(f.next.length,0);
    f.event('playing');f.advance(1999);assert.equal(f.next.length,0);assert.equal(f.video.currentTime,type==='opening'?10:550);
    f.advance(1);assert.equal(type==='opening'?f.video.currentTime:f.next.length,type==='opening'?40:1);f.controller.destroy();
  }
});

test('community countdown cancellation persists and immediate actions keep manual provenance',()=>{
  const f=automaticReferenceFixture();f.at(10);f.advance(1000);f.controller.cancelOpeningButton.dispatchEvent(new Event('click'));
  f.advance(10000);assert.equal(f.video.currentTime,10);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  f.controller.openingButton.dispatchEvent(new Event('click'));assert.equal(f.video.currentTime,40);
  f.at(550);f.advance(1000);f.controller.cancelNextButton.dispatchEvent(new Event('click'));f.advance(10000);assert.equal(f.next.length,0);
  f.controller.creditsButton.dispatchEvent(new Event('click'));assert.deepEqual(f.next,[{automatic:false,reason:'credits',approximate:false}]);f.controller.destroy();
  const immediate=automaticReferenceFixture();immediate.at(10);immediate.controller.skipOpeningNowButton.dispatchEvent(new Event('click'));
  assert.equal(immediate.video.currentTime,40);immediate.at(550);immediate.controller.playNextButton.dispatchEvent(new Event('click'));
  assert.deepEqual(immediate.next,[{automatic:false,reason:'credits',approximate:false}]);immediate.advance(10000);assert.equal(immediate.next.length,1);immediate.controller.destroy();
});

test('disabling automation or selecting ended suppresses community countdowns while manual actions remain',()=>{
  const f=automaticReferenceFixture();f.at(10);f.preferences.setPreferences({autoSkipOpening:false});f.advance(10000);
  assert.equal(f.video.currentTime,10);assert.equal(f.controller.openingButton.hidden,false);
  f.at(550);f.preferences.setPreferences({autoNext:false});f.advance(10000);assert.equal(f.next.length,0);assert.equal(f.controller.creditsButton.hidden,false);
  f.preferences.setPreferences({autoNext:true,nextMode:'ended'});f.advance(10000);assert.equal(f.next.length,0);
  f.video.currentTime=600;f.video.ended=true;f.event('ended');f.advance(5000);assert.equal(f.next.length,1);f.controller.destroy();
});

test('late community references start a full countdown and short or departed windows cannot jump into content',async()=>{
  let resolve;const f=automaticReferenceFixture({getEpisodeMarkers:()=>new Promise(done=>resolve=done)});
  f.at(15);f.advance(30000);assert.equal(f.controller.openingCountdownPanel.hidden,true);
  resolve(publicReference({...playableEpisode,duration:600}));await Promise.resolve();assert.equal(f.controller.openingCountdownTitle.textContent,'Pular abertura em 5s');
  f.advance(4999);assert.equal(f.video.currentTime,15);f.advance(1);assert.equal(f.video.currentTime,40);f.controller.destroy();
  const short=automaticReferenceFixture();short.at(37);short.advance(10000);assert.equal(short.video.currentTime,37);assert.equal(short.controller.openingCountdownPanel.hidden,true);short.controller.destroy();
  const scene=automaticReferenceFixture({segments:{outro:{start:550,end:580,source:'IntroDB'}}});
  scene.at(578);scene.advance(1000);scene.at(580);scene.advance(10000);assert.equal(scene.video.currentTime,580);assert.equal(scene.next.length,0);scene.controller.destroy();
});

test('account, episode, source and runtime changes revoke community countdowns and stale timers',()=>{
  for(const type of ['opening','credits'])for(const change of ['account','episode','source','duration']){
    const f=automaticReferenceFixture();f.at(type==='opening'?10:550);const stale=[...f.timers.values()][0].run;f.advance(1000);
    if(change==='account')f.account('b'.repeat(64));
    else if(change==='duration'){f.video.paused=true;f.event('pause');f.video.duration=620;f.event('durationchange');}
    else f.controller.attach({...playableEpisode,...(change==='source'?{sourceFingerprint:'another-source'}:{episode:{id:'201',season:1,number:2}})});
    stale();f.advance(10000);assert.equal(f.video.currentTime,type==='opening'?10:550);assert.equal(f.next.length,0);f.controller.destroy();
  }
});

test('a pending asynchronous credits seek is never submitted twice',async()=>{
  let resolve;const seeks=[],f=automaticReferenceFixture({segments:{outro:{start:550,end:580,source:'IntroDB'}},onSeek:target=>{seeks.push(target);return new Promise(done=>resolve=done);}});
  f.at(550);f.advance(20000);assert.deepEqual(seeks,[580]);assert.equal(f.next.length,0);
  resolve(true);await Promise.resolve();f.advance(10000);assert.deepEqual(seeks,[580]);f.controller.destroy();
});
