import test from 'node:test';
import assert from 'node:assert/strict';
import {TVAdaptiveQuality,nextTVQualityTarget} from '../web/tv/player/qualidade-adaptativa.js';
import {blockedSourceFailure,createLiveSourceState,decideLiveSourceFallback,prepareTVHlsStartup} from '../web/tv/canais/resolucoes.js';
import {PlayerTools} from '../web/player-tools.js';
import {ChannelSwitchController} from '../web/player/troca-canal/orquestrador.js';

const channel=(id,name)=>({id,name,kind:'live'});
const uhd=channel('4k','Canal Sergipe 4K'),fhd=channel('fhd','Canal Sergipe FHD'),hd=channel('hd','Canal Sergipe HD');
function harness(overrides={}){
  let clock=1000;const notices=[],steps=[],document={hidden:false};
  const current={item:uhd,started:true,sources:[{id:'uhd',quality:'4K'},{id:'fhd',quality:'FHD'},{id:'hd',quality:'HD'}],
    sourceId:'uhd',onSourceChange:()=>{},variants:[uhd,fhd,hd],qualityMode:'auto',...overrides};
  const context={current,video:{paused:false,ended:false,seeking:false},enabled:true};
  const quality=new TVAdaptiveQuality({getContext:()=>context,document,now:()=>clock,onNotice:notice=>notices.push(notice),onStep:(...args)=>steps.push(args)});
  return {quality,current,context,notices,steps,document,setTime:value=>clock=value,
    stall(at){clock=at;quality.recordStall();},update(at){clock=at;quality.update();}};
}
const four=(h,start=1000)=>{for(let i=0;i<4;i++)h.stall(start+i*1000);};

test('four stalls in 30 seconds open a five-second warning before exactly one lower step',()=>{
  const h=harness();for(let i=0;i<3;i++)h.stall(1000+i*1000);
  assert.equal(h.quality.pending,null);assert.equal(h.steps.length,0);
  h.stall(4000);assert.equal(h.notices.at(-1).seconds,5);assert.match(h.notices.at(-1).message,/4 vezes/);
  h.update(7999);assert.equal(h.notices.at(-1).seconds,2);assert.equal(h.steps.length,0);
  h.update(8999);assert.equal(h.notices.at(-1).seconds,1);assert.equal(h.steps.length,0);
  h.update(9000);assert.equal(h.steps.length,1);assert.equal(h.steps[0][0].source.id,'fhd');assert.equal(h.steps[0][1].item,uhd);
  h.update(20000);assert.equal(h.steps.length,1);assert.equal(h.notices.at(-1).visible,false);
});

test('old stalls expire and cancelling requires four fresh episodes',()=>{
  const h=harness();h.stall(1000);h.stall(2000);h.stall(3000);h.stall(34000);assert.equal(h.quality.pending,null);
  h.stall(35000);h.stall(36000);h.stall(37000);assert.ok(h.quality.pending);
  h.quality.cancel();h.update(50000);assert.equal(h.steps.length,0);
  for(let i=0;i<3;i++)h.stall(51000+i*1000);assert.equal(h.quality.pending,null);
  h.stall(54000);assert.ok(h.quality.pending);h.update(59000);assert.equal(h.steps.length,1);
});

test('pause, manual selection, hidden page, blocked errors and source replacement cancel the warning',()=>{
  const mutations=[h=>h.context.video.paused=true,h=>h.context.enabled=false,h=>h.document.hidden=true,
    h=>h.current.sourceFallbackBlocked=true,h=>h.current.sourceSwitchPending=true,h=>h.current.failed=true,
    h=>h.current.rateLimitedUntil=30000,h=>h.context.video.seeking=true,h=>h.context.current={...h.current}];
  for(const mutate of mutations){const h=harness();four(h);mutate(h);h.update(9000);assert.equal(h.steps.length,0);assert.equal(h.quality.pending,null);}
  const h=harness();four(h);h.current.sources=h.current.sources.filter(source=>source.id!=='fhd');h.update(9000);assert.equal(h.steps.length,0,'A changed target is not applied after the countdown.');
});

test('a quality countdown cannot compete with an explicit pending channel selection',async()=>{
  const h=harness(),committed=[];let finish;
  const prepared=new Promise(resolve=>{finish=resolve;}),switcher=new ChannelSwitchController({getScope:()=> 'synthetic',getCurrent:()=>h.current,
    isAllowed:()=>true,service:{prepare:()=>prepared},commit:item=>committed.push(item.id)});
  h.quality.getContext=()=>({...h.context,navigationPending:switcher.isPending()});
  four(h);const selection=switcher.select(channel('3','Band News'));
  h.update(9000);assert.equal(h.steps.length,0);assert.equal(h.quality.pending,null);
  finish({});await selection;assert.deepEqual(committed,['3']);
});

test('clock rollback and VOD never trigger a quality change',()=>{
  const h=harness();four(h);h.update(500);assert.equal(h.quality.pending,null);assert.equal(h.steps.length,0);
  for(const kind of ['movie','series']){const vod=harness({item:{...uhd,kind}});four(vod);vod.update(9000);assert.equal(vod.quality.pending,null);assert.equal(vod.steps.length,0);}
});

test('the lowest or unknown source shows one bounded notice without inventing a quality',()=>{
  for(const current of [{item:hd,sources:[],variants:[hd]},{item:channel('unknown','Canal Sergipe'),sources:[],variants:[hd]}]){
    const h=harness(current);four(h);assert.equal(h.quality.pending.target,null);assert.match(h.notices.at(-1).message,/não oferece/);
    h.update(9000);h.update(20000);assert.equal(h.steps.length,0);assert.equal(h.quality.pending,null);
    h.stall(21000);assert.equal(h.quality.pending,null,'A metrics tick cannot reopen the notice without four new stalls.');
  }
});

test('manifest levels descend one offered compatible step in any order and stop at the minimum',()=>{
  const current={item:uhd,hls:{levels:[{height:720,bitrate:2e6},{height:2160,bitrate:12e6},{height:1080,bitrate:5e6}],currentLevel:1},sources:[]};
  let next=nextTVQualityTarget(current);assert.equal(next.index,2);current.appAutoLevel=next.index;
  next=nextTVQualityTarget(current);assert.equal(next.index,0);current.appAutoLevel=next.index;
  current.sources=[{id:'uhd',quality:'4K'},{id:'fhd',quality:'FHD'},{id:'hd',quality:'HD'}];current.sourceId='uhd';current.onSourceChange=()=>{};
  assert.equal(nextTVQualityTarget(current),null,'A lower manifest level cannot jump back up through the original descriptor.');
});

test('a single-level manifest caps descriptor and catalog reductions at its actual offered height',()=>{
  const current={item:uhd,hls:{levels:[{height:720}],currentLevel:0},sourceId:'uhd',onSourceChange:()=>{},
    sources:[{id:'uhd',quality:'4K'},{id:'fhd',quality:'FHD'},{id:'hd',quality:'HD'},{id:'sd',quality:'SD'}]};
  assert.equal(nextTVQualityTarget(current).source.id,'sd');current.sources=current.sources.slice(0,3);assert.equal(nextTVQualityTarget(current),null);
  current.sources=[];current.variants=[uhd,fhd,hd];assert.equal(nextTVQualityTarget(current),null);
});

test('unsupported codecs are excluded and native playback uses only declared source steps',()=>{
  const prior=globalThis.MediaSource;globalThis.MediaSource={isTypeSupported:value=>!value.includes('hev1')};
  try{
    const current={item:uhd,hls:{levels:[{height:2160,videoCodec:'avc1.640028'},{height:1080,videoCodec:'hev1.1.6.L93'},{height:720,videoCodec:'avc1.640028'}],currentLevel:0}};
    assert.equal(nextTVQualityTarget(current).index,2);
  }finally{if(prior===undefined)delete globalThis.MediaSource;else globalThis.MediaSource=prior;}
  const native={item:uhd,hls:null,sourceId:'4k',onSourceChange:()=>{},sources:[{id:'hd',quality:'HD'},{id:'4k',quality:'4K'},{id:'fhd',quality:'FHD'}]};
  assert.equal(nextTVQualityTarget(native).source.id,'fhd');native.sourceCapabilities=new Map([['fhd',false]]);assert.equal(nextTVQualityTarget(native).source.id,'hd');
  native.sources=[{id:'4k',quality:'4K'}];assert.equal(nextTVQualityTarget(native),null);
  native.sources=[{id:'4k',quality:'4K',videoCodec:'avc1.640028'},{id:'fhd',quality:'FHD',videoCodec:'hvc1.1.6.L93'},
    {id:'hd',quality:'HD',videoCodec:'avc1.640028'}];native.sourceCapabilities=new Map();
  assert.equal(nextTVQualityTarget(native).source.id,'hd','A changed declared codec needs positive compatibility.');
  native.sourceCapabilities.set('fhd',true);assert.equal(nextTVQualityTarget(native).source.id,'fhd');
});

test('automatic quality cannot open another catalogue ID even with an identical family and compatible codec',()=>{
  const current={item:channel('a','Canal 2 SP +1 4K AVC'),sources:[],variants:[channel('b','Canal 2 RJ +1 HD'),channel('c','Canal 3 SP +1 HD'),
    channel('d','Canal 2 SP HD'),channel('e','Canal 2 SP +1 FHD HEVC'),channel('f','Canal 2 SP +1 HD AVC')]};
  assert.equal(nextTVQualityTarget(current),null);current.sourceCapabilities=new Map([['e',true]]);assert.equal(nextTVQualityTarget(current),null);
  const calls=[],tools={current,autoQuality:true,video:{paused:false,ended:false},options:{switchChannel:()=>calls.push('foreign-id')}};
  assert.equal(PlayerTools.prototype.applyTVQualityStep.call(tools,{kind:'variant',item:current.variants.at(-1),key:'variant:f'},current),false);
  assert.equal(calls.length,0);
});

test('fatal recovery stays at the same declared quality, respects its budget and never bypasses blocked statuses',()=>{
  const sources=[{id:'a',quality:'4K'},{id:'b',quality:'4K'},{id:'c',quality:'4K'},{id:'d',quality:'4K'},{id:'low',quality:'FHD'}];
  let state=createLiveSourceState({sourceId:'a',now:0});
  let decision=decideLiveSourceFallback({state,sources,sourceId:'a',now:1000,reason:'source-error'});assert.equal(decision.target.id,'b');state=decision.state;
  assert.equal(decideLiveSourceFallback({state,sources,sourceId:'b',now:2000,reason:'source-error'}).target,null);
  decision=decideLiveSourceFallback({state,sources,sourceId:'b',now:5000,reason:'source-error'});assert.equal(decision.target.id,'c');
  assert.equal(decideLiveSourceFallback({state:decision.state,sources,sourceId:'c',now:9000,reason:'source-error'}).target,null);
  assert.equal(decideLiveSourceFallback({sources:[sources[0],sources.at(-1)],sourceId:'a',now:1000,reason:'source-error'}).target,null);
  for(const status of [401,403,409,429]){assert.equal(blockedSourceFailure({status}),true);assert.equal(decideLiveSourceFallback({sources,sourceId:'a',now:1000,reason:'source-error',status}).target,null);}
  for(const reason of ['startup-slow','repeated-stalls'])assert.equal(decideLiveSourceFallback({sources,sourceId:'a',now:1000,reason,stalls:99,started:true}).target,null);
});

test('startup fixes the highest supported manifest level and an approved step changes no decoder or channel',()=>{
  const calls=[],hls={levels:[{height:720},{height:2160},{height:1080}],currentLevel:1,config:{},startLoad:()=>calls.push('start')};
  const current={item:uhd,hls,qualityMode:'auto',sources:[],variants:[uhd,fhd,hd],started:true};
  const tools={autoQuality:true,current,video:{paused:false,ended:false},applyAutoQuality:PlayerTools.prototype.applyAutoQuality,
    renderQuality:()=>calls.push('render'),options:{switchChannel:()=>calls.push('switch')}};
  prepareTVHlsStartup(tools);assert.equal(hls.startLevel,1);assert.equal(hls.loadLevel,1);assert.equal(hls.config.preserveManualLevelOnError,true);
  const target=nextTVQualityTarget(current);assert.equal(PlayerTools.prototype.applyTVQualityStep.call(tools,target,current),true);
  assert.equal(hls.loadLevel,2);assert.deepEqual(calls,['start','render']);assert.equal(current.qualityMode,'auto');
  prepareTVHlsStartup(tools);assert.deepEqual(calls,['start','render'],'Manifest updates cannot restart the engine.');
});

test('real waiting events exclude startup, duplicates, seeking and pause before opening the warning',t=>{
  let clock=1000;t.mock.method(Date,'now',()=>clock);t.mock.method(globalThis,'setInterval',()=>1);
  const video=Object.assign(new EventTarget(),{paused:false,ended:false,seeking:false,readyState:3,videoWidth:1920,videoHeight:1080}),document={hidden:false},notices=[];
  const player={video,profiles:{live:'balanced'},autoQuality:true,listeners:[],
    listen:PlayerTools.prototype.listen,renderMenus:()=>{},applyAutoQuality:()=>{},inspectSourceCapabilities:async()=>{},observeRecoveryProgress:()=>{},
    reset(){this.tvQuality?.reset();for(const remove of this.listeners)remove();this.listeners=[];},updateMetrics(){this.tvQuality?.update();}};
  player.tvQuality=new TVAdaptiveQuality({getContext:()=>({current:player.current,video,enabled:player.autoQuality&&player.current?.qualityMode!=='manual'}),document,now:()=>clock,onNotice:n=>notices.push(n)});
  PlayerTools.prototype.attach.call(player,{item:uhd,variants:[uhd,fhd,hd],sources:[{id:'uhd',quality:'4K'},{id:'fhd',quality:'FHD'}],sourceId:'uhd',onSourceChange:()=>{}});
  const emit=name=>video.dispatchEvent(new Event(name));emit('waiting');assert.equal(player.current.stalls,0);
  emit('playing');emit('waiting');emit('waiting');assert.equal(player.current.stalls,1);
  emit('playing');video.seeking=true;emit('waiting');video.seeking=false;assert.equal(player.current.stalls,1);
  video.paused=true;emit('pause');emit('waiting');video.paused=false;assert.equal(player.current.stalls,1);
  for(let i=0;i<3;i++){clock+=1000;emit('playing');emit('waiting');}assert.equal(player.tvQuality.pending,null,'Pause erased the earlier episode.');
  clock+=1000;emit('playing');emit('waiting');assert.equal(player.current.stalls,5);assert.equal(notices.at(-1).seconds,5);
  emit('seeking');assert.equal(player.tvQuality.pending,null);player.reset();
});

test('the cancellable warning lives inside the supplied video stage',()=>{
  const make=()=>({children:[],events:new Map(),setAttribute(name,value){this[name]=value;},addEventListener(name,listener){this.events.set(name,listener);},
    append(...children){this.children.push(...children);},remove(){this.removed=true;}});
  const document={hidden:false,createElement:make},stage=make(),h=harness();let clock=1000;
  h.quality.dispose();h.quality=new TVAdaptiveQuality({stage,document,getContext:()=>h.context,now:()=>clock});
  for(let i=0;i<4;i++){clock+=1000;h.quality.recordStall();}assert.equal(stage.children.length,1);assert.equal(h.quality.notice.hidden,false);assert.equal(h.quality.notice.role,'status');
  assert.equal(h.quality.button.textContent,'Manter qualidade');h.quality.button.events.get('click')({stopPropagation(){}});assert.equal(h.quality.notice.hidden,true);
  const notice=h.quality.notice;h.quality.dispose();assert.equal(notice.removed,true);
});
