import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_LIMITER, AUDIO_PRESETS, AudioProcessing, compressorCompensation, isLocalAudioSource, webKitAudioRoutingUnsafe } from '../web/audio-processing.js';

class Param {
  constructor(value=1) {this.value=value;this.events=[];}
  cancelScheduledValues(time) {this.events.push(['cancel',time]);}
  cancelAndHoldAtTime(time) {this.events.push(['hold',time]);}
  setValueAtTime(value,time) {this.value=value;this.events.push(['set',value,time]);}
  linearRampToValueAtTime(value,time) {this.value=value;this.events.push(['ramp',value,time]);}
}
class AudioNode {
  constructor(kind) {this.kind=kind;this.connections=[];this.disconnects=0;}
  connect(destination) {this.connections.push(destination);return destination;}
  disconnect() {this.disconnects++;}
}
function fixture({mode='original',userAgent='Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36',gesture=true,source='/api/play/live/1/index.m3u8',contextState='suspended',resumeReject=false,sourceFailure=false,compressorFailure=false,wetFailure=false,storageFailure=false}={}) {
  const contexts=[],video={volume:.37,muted:true,currentSrc:''};let hasGesture=gesture;
  const saved=new Map(mode==='original'?[]:[['arkhen.audio-processing.v1',JSON.stringify({mode})]]);
  const storage={getItem:key => {if(storageFailure)throw new Error('blocked');return saved.get(key)||null;},setItem:(key,value) => {if(storageFailure)throw new Error('blocked');saved.set(key,value);}};
  class Context {
    constructor() {this.state=contextState;this.currentTime=5;this.destination=new AudioNode('destination');this.created=[];this.sourceCalls=0;this.resumeCalls=0;this.closes=0;this.suspends=0;this.events=new Map();contexts.push(this);}
    addEventListener(name,listener) {this.events.set(name,listener);}
    resume() {this.resumeCalls++;if(resumeReject)return Promise.reject(new Error('not allowed'));this.state='running';return Promise.resolve();}
    close() {this.closes++;this.state='closed';}
    suspend() {this.suspends++;this.state='suspended';}
    changeState(state) {this.state=state;this.events.get('statechange')?.();}
    createGain() {const node=new AudioNode('gain');node.gain=new Param();this.created.push(node);return node;}
    createDynamicsCompressor() {
      if(compressorFailure)throw new Error('compressor unavailable');
      const node=new AudioNode('compressor');for(const name of ['threshold','ratio','knee','attack','release'])node[name]=new Param();node.reduction=0;this.created.push(node);return node;
    }
    createMediaElementSource(element) {
      assert.equal(this.state,'running','capture must wait for running context');
      if(sourceFailure)throw new Error('already captured');
      this.sourceCalls++;const node=new AudioNode('source');node.mediaElement=element;
      if(wetFailure){const normal=node.connect.bind(node);node.connect=destination => {if(destination.kind==='compressor')throw new Error('failed wet route');return normal(destination);};}
      this.source=node;this.created.push(node);return node;
    }
  }
  const options={storage,AudioContextClass:Context,baseURL:'http://localhost:4173/',userAgent,isUserGesture:() => hasGesture};
  const audio=new AudioProcessing(video,options);
  if(source)audio.beginSourceChange({url:source,transport:'mse'});
  return {audio,video,contexts,saved,storage,options,setGesture:value => {hasGesture=value;}};
}

test('original is the default and leaves HTML volume, mute and native routing untouched', async () => {
  const f=fixture();
  assert.deepEqual(f.audio.getPreferences(),{mode:'original'});
  assert.equal(await f.audio.requestActivation(),false);assert.equal(f.contexts.length,0);
  f.audio.finishSourceChange();f.audio.reset();
  assert.equal(f.audio.getStatus().state,'original');assert.equal(f.video.volume,.37);assert.equal(f.video.muted,true);
});

test('gesture activation builds one graph once and reuses it across channels, settings changes and resets', async () => {
  const f=fixture({mode:'balanced'});
  assert.equal(await f.audio.requestActivation(),true);
  const context=f.contexts[0],nodes=f.audio.nodes;
  assert.equal(context.sourceCalls,1);assert.equal(f.audio.getStatus().active,true);
  assert.deepEqual(context.source.connections,[nodes.dry,nodes.compressor]);
  assert.deepEqual(nodes.compressor.connections,[nodes.compensation]);
  assert.deepEqual(nodes.compensation.connections,[nodes.limiter]);
  assert.deepEqual(nodes.limiter.connections,[nodes.limiterCompensation]);
  assert.deepEqual(nodes.limiterCompensation.connections,[nodes.wet]);
  assert.deepEqual(nodes.dry.connections,[nodes.output]);assert.deepEqual(nodes.wet.connections,[nodes.output]);
  assert.deepEqual(nodes.output.connections,[context.destination]);
  for(let id=2;id<5;id++){f.audio.reset();f.audio.beginSourceChange({url:`/api/play/live/${id}/index.m3u8`,transport:'mse'});f.audio.finishSourceChange();await f.audio.requestActivation();}
  f.audio.setPreferences({mode:'night'});f.audio.setPreferences({mode:'original'});f.audio.setPreferences({mode:'balanced'});
  assert.equal(f.contexts.length,1);assert.equal(context.sourceCalls,1);assert.equal(context.closes,0);assert.equal(context.suspends,0);assert.equal(context.source.disconnects,0);
  assert.equal(new AudioProcessing(f.video,f.options),f.audio);
  assert.equal(f.video.volume,.37);assert.equal(f.video.muted,true);
});

test('both compressors cancel native makeup gain, so quiet signals are never boosted', async () => {
  const f=fixture({mode:'balanced'});await f.audio.requestActivation();
  for(const [mode,preset] of Object.entries(AUDIO_PRESETS)) {
    f.audio.setPreferences({mode});
    for(const [processor,compensation,settings] of [[f.audio.nodes.compressor,f.audio.nodes.compensation,preset],[f.audio.nodes.limiter,f.audio.nodes.limiterCompensation,AUDIO_LIMITER]]) {
      assert.equal(processor.knee.value,0);assert.equal(compensation.gain.value<=1,true);
      // Independent static hard-knee reference in dB, including the W3C's 0.6 makeup power.
      const outputAtFullScaleDb=settings.threshold+(0-settings.threshold)/settings.ratio;
      const nativeMakeup=10**(-outputAtFullScaleDb*.6/20);
      for(const inputDb of [-90,-45,-30,-18,-10,-3,0]) {
        const compressedDb=inputDb<=settings.threshold?inputDb:settings.threshold+(inputDb-settings.threshold)/settings.ratio;
        const input=10**(inputDb/20),output=10**(compressedDb/20)*nativeMakeup*compensation.gain.value;
        assert.equal(output<=input*(1+1e-12),true,`${mode} must not boost ${inputDb} dB`);
      }
      assert.equal(Math.abs(nativeMakeup*compensation.gain.value-1)<1e-12,true);
    }
  }
  assert.throws(() => compressorCompensation({threshold:-20,ratio:4,knee:20}),RangeError);
});

test('source changes use a brief processing ramp and original bypass always returns to unity', async () => {
  const f=fixture({mode:'balanced'});await f.audio.requestActivation();f.audio.finishSourceChange();
  const {output,dry,wet}=f.audio.nodes,context=f.contexts[0];context.currentTime=9;
  f.audio.beginSourceChange({url:'/api/play/live/9/index.m3u8',transport:'mse'});
  const down=output.gain.events.at(-1);assert.equal(down[0],'ramp');assert.equal(down[1]>0&&down[1]<1,true);assert.equal(down[2],9.005);
  f.audio.finishSourceChange();assert.deepEqual(output.gain.events.at(-1),['ramp',1,9.15]);
  f.audio.setPreferences({mode:'original'});
  assert.equal(dry.gain.value,1);assert.equal(wet.gain.value,0);assert.equal(output.gain.value,1);
  f.audio.beginSourceChange({url:'/api/play/movie/10.mp4',transport:'file'});
  assert.equal(output.gain.value,1);assert.equal(f.audio.getStatus().state,'original');
  assert.equal(f.video.volume,.37);assert.equal(f.video.muted,true);
});

test('without a current user gesture the video stays native, and blocked resume never captures it', async () => {
  const f=fixture({mode:'balanced',gesture:false});
  assert.equal(await f.audio.requestActivation(),false);assert.equal(f.contexts.length,0);assert.equal(f.audio.getStatus().state,'suspended');
  f.setGesture(true);assert.equal(await f.audio.requestActivation(),true);
  const blocked=fixture({mode:'balanced',resumeReject:true});
  assert.equal(await blocked.audio.requestActivation(),false);assert.equal(blocked.contexts[0].sourceCalls,0);
  assert.equal(blocked.audio.getStatus().state,'suspended');assert.equal(blocked.video.volume,.37);
});

test('all Safari and iOS formats stay native before capture because HLS can silence Web Audio routing', async () => {
  for(const userAgent of [
    'Mozilla/5.0 Macintosh AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
    'Mozilla/5.0 iPhone AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1',
    'Mozilla/5.0 iPhone AppleWebKit/605.1.15 CriOS/140.0 Mobile Safari/604.1',
    'Mozilla/5.0 iPad AppleWebKit/605.1.15 FxiOS/140.0 Mobile'
  ]) {
    const f=fixture({mode:'balanced',userAgent,source:'/api/play/movie/10.mp4'});
    assert.equal(await f.audio.requestActivation(),false);assert.equal(f.audio.getStatus().state,'unsupported');
    assert.equal(f.audio.getStatus().reason,'webkit-media-routing');assert.equal(f.contexts.length,0);
    f.audio.setPreferences({mode:'original'});assert.equal(f.audio.getStatus().state,'original');
  }
  assert.equal(webKitAudioRoutingUnsafe('Mozilla/5.0 Macintosh',5),true);
  assert.equal(webKitAudioRoutingUnsafe('Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36'),false);
});

test('only the local proxy and locally created MSE blobs are accepted; CORS uncertainty never captures the video', async () => {
  assert.equal(isLocalAudioSource('/api/play/live/1/index.m3u8','http://localhost:4173/'),true);
  assert.equal(isLocalAudioSource('blob:http://localhost:4173/fixture','http://localhost:4173/'),true);
  for(const source of ['https://upstream.example/stream.m3u8','blob:https://other.example/id','data:audio/mp3;base64,test','javascript:alert(1)']) {
    const f=fixture({mode:'balanced',source});assert.equal(await f.audio.requestActivation(),false);
    assert.equal(f.audio.getStatus().reason,'cross-origin-source');assert.equal(f.contexts.length,0);
  }
  const redirected=fixture({mode:'balanced'});redirected.video.currentSrc='https://other.example/audio';
  assert.equal(await redirected.audio.requestActivation(),false);assert.equal(redirected.contexts.length,0);
});

test('a compressor failure before capture leaves native routing intact and source failures never claim protection', async () => {
  for(const options of [{compressorFailure:true},{sourceFailure:true}]) {
    const f=fixture({mode:'balanced',...options});assert.equal(await f.audio.requestActivation(),false);
    assert.equal(f.audio.getStatus().state,'error');assert.equal(f.contexts[0].sourceCalls,0);
    assert.equal(f.video.volume,.37);assert.equal(f.video.muted,true);
    f.audio.setPreferences({mode:'original'});assert.equal(f.audio.getStatus().state,'original');
  }
});

test('a wet graph connection failure after capture retains one unprocessed dry route', async () => {
  const f=fixture({mode:'balanced',wetFailure:true});assert.equal(await f.audio.requestActivation(),false);
  const context=f.contexts[0];assert.equal(context.sourceCalls,1);assert.equal(context.source.connections.length,1);
  assert.equal(context.source.connections[0],f.audio.nodes.dry);
  assert.equal(f.audio.nodes.dry.gain.value,1);assert.equal(f.audio.nodes.wet.gain.value,0);assert.equal(f.audio.nodes.output.gain.value,1);
  assert.equal(f.audio.getStatus().state,'error');assert.equal(context.source.disconnects,0);
  assert.equal(await f.audio.requestActivation(),false);assert.equal(f.audio.getStatus().state,'error');assert.equal(context.sourceCalls,1);
  f.audio.setPreferences({mode:'original'});assert.equal(f.audio.getStatus().state,'original');
});

test('a suspended captured context is reported honestly and is resumed instead of recreated', async () => {
  const f=fixture({mode:'balanced'});await f.audio.requestActivation();const context=f.contexts[0];
  context.changeState('suspended');assert.equal(f.audio.getStatus().state,'suspended');assert.equal(f.audio.getStatus().active,false);
  f.audio.setPreferences({mode:'original'});assert.equal(f.audio.getStatus().state,'suspended');
  await f.audio.requestActivation();assert.equal(f.audio.getStatus().state,'original');assert.equal(context.state,'running');
  context.changeState('suspended');
  f.audio.setPreferences({mode:'balanced'});assert.equal(await f.audio.requestActivation(),true);
  assert.equal(context.sourceCalls,1);assert.equal(f.contexts.length,1);assert.equal(context.closes,0);
  context.changeState('closed');
  assert.equal(await f.audio.requestActivation(),false);assert.equal(f.audio.getStatus().reason,'context-closed');
  assert.equal(f.contexts.length,1);assert.equal(context.sourceCalls,1);
});

test('a pending browser resume times out before capture and a later gesture can retry the same context', async () => {
  const video={volume:.7,muted:false,currentSrc:''};let contexts=0,resumes=0,captures=0;
  class WaitingContext {
    constructor(){contexts++;this.state='suspended';this.currentTime=0;}
    resume(){resumes++;return new Promise(() => {});}
    createMediaElementSource(){captures++;throw new Error('must not capture');}
  }
  const audio=new AudioProcessing(video,{storage:null,AudioContextClass:WaitingContext,baseURL:'http://localhost/',userAgent:'fixture',isUserGesture:()=>true,activationTimeoutMs:5});
  audio.setPreferences({mode:'balanced'});audio.beginSourceChange({url:'/api/play/live/1/index.m3u8'});
  const first=audio.requestActivation(),shared=audio.requestActivation();assert.equal(first,shared);
  assert.equal(await first,false);assert.equal(audio.getStatus().state,'suspended');
  assert.equal(await audio.requestActivation(),false);
  assert.equal(contexts,1);assert.equal(resumes,2);assert.equal(captures,0);assert.equal(video.volume,.7);assert.equal(video.muted,false);
});

test('preferences persist by device, tolerate blocked storage, and status subscriptions can be removed', async () => {
  const f=fixture();const statuses=[],unsubscribe=f.audio.subscribe(status => statuses.push(status));
  f.audio.setPreferences({mode:'night'});
  assert.deepEqual(JSON.parse(f.saved.get('arkhen.audio-processing.v1')),{mode:'night'});
  assert.equal(statuses.at(-1).mode,'night');unsubscribe();const count=statuses.length;
  f.audio.setPreferences({mode:'balanced'});assert.equal(statuses.length,count);
  f.audio.setPreferences({mode:'invalid'});assert.equal(f.audio.getPreferences().mode,'balanced');
  const blocked=fixture({storageFailure:true});blocked.audio.setPreferences({mode:'night'});assert.equal(blocked.audio.getPreferences().mode,'night');
  const noAPI=new AudioProcessing({volume:.8,muted:false},{AudioContextClass:null,storage:null,userAgent:'fixture'});
  noAPI.setPreferences({mode:'balanced'});assert.equal(noAPI.getStatus().state,'unsupported');assert.equal(await noAPI.requestActivation(),false);
});
