import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {SeriesPlayback} from '../web/serie/reproducao.js';
import {SeriesAudio,renderSeriesAudio} from '../web/serie/audio.js';
import {addSeriesSubtitle,SERIES_SUBTITLE_MAX_BYTES} from '../web/serie/legenda.js';
import {applySeriesQuality,seriesQualitySelection} from '../web/serie/resolucao.js';
import {seriesPlayerConfig} from '../web/serie/buffer.js';
import {PlayerTools} from '../web/player-tools.js';
import {PlaybackPositionGuard} from '../web/playback-position.js';

const item={kind:'series',id:'100',name:'Série'},episode={id:'501',title:'Episódio',season:1,number:1,container:'mp4'};
function fixture(){
  const video=Object.assign(new EventTarget(),{currentTime:0,duration:1800,paused:false,ended:false}),scope={account:'account_A',epoch:1},events=[];
  Object.defineProperty(video,'src',{set:()=>assert.fail('The policy cannot open media')});
  const positionGuard=new PlaybackPositionGuard(),vodSeek={pending:null,attach:value=>events.push(['attach',value]),request:(...value)=>events.push(['seek',...value])};
  const resumePrompt={attach:value=>events.push(['prompt',value])};let current=true,clock=10000;
  const playback=new SeriesPlayback({video,vodSeek,positionGuard,resumePrompt,getScope:()=>scope,serializeItem:value=>({...value}),now:()=>clock});
  const attach=(options={})=>playback.attach({item,episode,accountLibraryId:'account_A',isCurrent:()=>current,
    onReady:()=>events.push(['ready']),playNow:()=>events.push(['play']),...options});
  return {video,scope,events,positionGuard,vodSeek,playback,attach,setCurrent:value=>{current=value;},setClock:value=>{clock=value;}};
}

test('series resumes the exact episode and cannot replace saved position with pre-metadata zero',()=>{
  const f=fixture();
  const attached=f.attach({episodeEntry:{itemId:'100',episodeId:'501',time:120,duration:1800},historyEntry:{item,episode:{id:'999'},time:800,duration:1800}});
  assert.equal(attached.resumeTime,120);assert.equal(attached.sourceKey,'series:100:501');
  assert.equal(f.playback.progress({force:true}),null);
  assert.equal(f.playback.continuation().resumeTime,120);
  f.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(f.events.filter(value=>value[0]==='seek').length,1);
  assert.deepEqual(f.events.find(value=>value[0]==='seek').slice(1),[120,{play:true,reason:'resume'}]);
  assert.equal(f.playback.progress({force:true}),null);
  f.video.currentTime=120;f.positionGuard.observe({state:'ready'});
  const entry=f.playback.progress();assert.equal(entry.time,120);assert.equal(entry.episode.id,'501');assert.equal(entry.libraryId,'account_A');
  assert.equal(f.playback.progress({lastSavedAt:9999}),null);
  assert.equal(f.playback.progress({force:true,lastSavedAt:9999}).time,120);
  const other=fixture();assert.equal(other.attach({episodeEntry:{itemId:'100',episodeId:'999',time:500,duration:1800}}).resumeTime,0);
});

test('series old metadata callbacks cannot start another episode or a different account',()=>{
  const f=fixture();f.attach();const old=getEventListeners(f.video,'loadedmetadata')[0];
  f.attach({episode:{...episode,id:'502'}});old();assert.equal(f.events.some(value=>value[0]==='play'),false);
  assert.equal(f.playback.session.episode.id,'502');
  f.scope.account='account_B';f.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(f.events.some(value=>value[0]==='play'),false);assert.equal(f.playback.progress({force:true}),null);
  assert.equal(f.playback.updateEpisode({...episode,id:'502',season:4}),false);
  f.playback.reset();assert.equal(getEventListeners(f.video,'loadedmetadata').length,0);
});

test('sequence hydration updates only the same episode and preserves private/adult progress rules',()=>{
  const f=fixture();f.attach();f.video.dispatchEvent(new Event('loadedmetadata'));f.video.currentTime=45;
  assert.equal(f.playback.updateEpisode({...episode,id:'999',season:2}),false);
  assert.equal(f.playback.updateEpisode({...episode,libraryId:'account_B'}),false);
  assert.equal(f.playback.updateEpisode({...episode,season:2,number:3,title:'Identificado'}),true);
  assert.deepEqual(f.playback.progress({force:true}).episode,{...episode,season:2,number:3,title:'Identificado'});
  assert.equal(f.playback.updateEpisode({...episode,isAdult:true}),true);
  assert.equal(f.playback.progress({force:true}),null);
  f.playback.updateEpisode(episode);f.playback.session.item={...item,isAdult:true};assert.equal(f.playback.progress({force:true}),null);
});

test('series seek recovery is single, current and respects cooldown/auth/STOP failures',()=>{
  const f=fixture();f.attach();
  const input={target:160,play:true,sourceKey:'series:100:501',recoveryAttempt:1};
  const options=f.playback.recoveryOptions(input,{quality:{qualityMode:'manual',qualityHeight:720}});
  assert.equal(options.resumeTime,160);assert.equal(options.qualityHeight,720);assert.equal(options.route,false);
  for(const constraint of [{status:429},{status:401},{status:403},{status:409},{code:'LIVE_STOP_UNCONFIRMED'},{retryAfterUntil:11000},{failed:true}])assert.equal(f.playback.recoveryOptions(input,constraint),null);
  assert.equal(f.playback.recoveryOptions({...input,recoveryAttempt:2}),null);
  assert.equal(f.playback.recoveryOptions({...input,sourceKey:'series:100:502'}),null);
  f.setCurrent(false);assert.equal(f.playback.recoveryOptions(input),null);
});

function menuTools(current){
  const labels=new Map(),choices=[],notes=[];
  const tools=Object.assign(Object.create(PlayerTools.prototype),{current,video:{videoWidth:1280,videoHeight:720,currentTime:45,audioTracks:[],textTracks:[]},
    autoQuality:true,profiles:{vod:'balanced',live:'low'},bufferMode:'balanced',localTracks:[],options:{},
    $:key=>{if(!labels.has(key))labels.set(key,{replaceChildren(){},textContent:''});return labels.get(key);},
    choice:(_menu,label,selected,action,detail,disabled)=>choices.push({label,selected,action,detail,disabled}),note:(_menu,text)=>notes.push(text)});
  return {tools,labels,choices,notes};
}

test('series quality/buffer dispatch uses only episode levels and never a TV variant/live sync',()=>{
  const hls={levels:[{height:360,width:640},{height:720,width:1280}],config:{},currentLevel:0,autoLevelEnabled:false},current={item,hls,qualityMode:'manual',manualHeight:720,forcedLevel:null};
  const {tools,choices,notes}=menuTools(current);tools.autoQuality=false;
  current.variants=[{kind:'series',id:'another-show',name:'4K'}];current.sources=[{id:'foreign-channel'}];
  tools.renderQuality();assert.equal(choices.length,3);assert.equal(choices.some(value=>value.label==='another-show'),false);
  assert.equal(applySeriesQuality(tools),true);assert.equal(hls.loadLevel,1);assert.equal(hls.config.preserveManualLevelOnError,true);
  assert.deepEqual(seriesQualitySelection(tools),{qualityMode:'manual',qualityHeight:720});
  tools.syncToProfile=()=>assert.fail('Episode profiles cannot sync to live');tools.setProfile('vod','stable');
  assert.equal(hls.config.maxBufferLength,60);assert.equal(hls.config.lowLatencyMode,false);assert.equal(tools.video.currentTime,45);
  assert.equal(tools.configFor('series').manifestLoadPolicy.default.errorRetry.maxNumRetry,0);
  assert.equal(seriesPlayerConfig('low').maxBufferLength,30);
  assert.equal(notes.some(value=>value.includes('posição do episódio')),true);
});

test('episode audio callbacks and playing events do not leak into the next selection',()=>{
  const hls={audioTracks:[{name:'Português'},{name:'Original'}],audioTrack:0},f=menuTools({item,hls});renderSeriesAudio(f.tools);
  const old=f.choices[1].action;f.tools.current={item:{...item,id:'200'},hls:{audioTracks:[],audioTrack:0}};old();assert.equal(hls.audioTrack,0);
  let current=true,finished=0,selected=0;
  const audio=new SeriesAudio({volumeMemory:{select:()=>selected++,reset(){}},audioProcessing:{beginSourceChange(){},requestActivation(){return Promise.resolve();},finishSourceChange(){finished++;},reset(){}}});
  assert.equal(audio.begin(item,'/api/play/series/501.mp4',{episode,isCurrent:()=>current}),true);assert.equal(selected,1);
  current=false;assert.equal(audio.playing(),false);assert.equal(finished,0);
  assert.equal(audio.begin({kind:'movie'},'/api/play/movie/1.mp4',{episode}),false);
});

test('local episode subtitles reject oversized files before reading and discard a late file after episode change',async()=>{
  const f=menuTools({item,hls:null});f.tools.options.toast=()=>{};
  const large={files:[{size:SERIES_SUBTITLE_MAX_BYTES+1,text:()=>assert.fail('Oversized subtitle cannot be read')}],value:'selected'};
  assert.equal(await addSeriesSubtitle(f.tools,large,{toVtt:()=>''}),false);assert.equal(large.value,'');
  let finish;
  const input={files:[{name:'legenda.srt',size:100,text:()=>new Promise(resolve=>{finish=resolve;})}],value:'selected'};
  const pending=addSeriesSubtitle(f.tools,input,{toVtt:()=>assert.fail('Obsolete episode cannot add a track')});
  f.tools.current={item:{...item,id:'200'},hls:null};finish('1\n00:00:00,000 --> 00:00:01,000\nOlá');
  assert.equal(await pending,false);assert.equal(f.tools.localTracks.length,0);
});
