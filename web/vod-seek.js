const userReasons = new Set(['user','opening','credits','restart']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Keep a VOD seek inside the media timeline and the ranges the browser offers. */
export function clampSeekTarget(video, target) {
  const duration = Number(video?.duration);
  if (!finite(target) || !Number.isFinite(duration) || duration <= 0) return null;
  const end = Math.max(0,duration-.05), bounded = Math.max(0,Math.min(end,target));
  const ranges = [];
  try {
    for (let index=0;index<(video.seekable?.length || 0);index++) {
      const start=Math.max(0,video.seekable.start(index)), stop=Math.min(end,video.seekable.end(index));
      if (Number.isFinite(start) && Number.isFinite(stop) && stop>=start) ranges.push([start,stop]);
    }
  } catch {return bounded;}
  if (!ranges.length || ranges.some(([start,stop])=>bounded>=start&&bounded<=stop)) return bounded;
  return ranges.flatMap(([start,stop])=>[start,Math.max(start,stop-.01)])
    .reduce((nearest,value)=>Math.abs(value-bounded)<Math.abs(nearest-bounded)?value:nearest,ranges[0][0]);
}

/**
 * One seek lifecycle per source. Recovery is delegated to the existing player
 * loader so that playback credentials, HLS and the audio graph stay centralized.
 */
export class VodSeekController {
  constructor({video,onRecover,onStateChange,stallMs=8000,metadataMs=15000,
    now=()=>globalThis.performance?.now?.() ?? Date.now(),
    setInterval:setTimer=(callback,delay)=>globalThis.setInterval(callback,delay),
    clearInterval:clearTimer=timer=>globalThis.clearInterval(timer)}={}) {
    if (!video) throw new TypeError('Vídeo inválido.');
    Object.assign(this,{video,onRecover,onStateChange,stallMs,metadataMs,now,setTimer,clearTimer});
    this.serial=0;this.session=null;this.pending=null;this.listeners=[];this.timer=null;
  }
  attach({kind,sourceKey='',recoveryAttempt=0}={}) {
    this.reset();
    if (!['movie','series'].includes(kind)) return false;
    this.session={serial:++this.serial,sourceKey:String(sourceKey),recoveryAttempt:recoveryAttempt>0?1:0};
    const listen=(event,callback)=>{this.video.addEventListener(event,callback);this.listeners.push(()=>this.video.removeEventListener(event,callback));};
    for (const event of ['loadedmetadata','durationchange','loadeddata','progress']) listen(event,()=>{this.#apply();this.#check();});
    for (const event of ['seeked','timeupdate','playing']) listen(event,()=>this.#check());
    listen('error',()=>{if(this.pending)this.#finish('failed','media-error');});
    listen('pause',()=>{if(this.pending)this.pending.play=false;});
    listen('play',()=>{if(this.pending)this.pending.play=true;});
    return true;
  }
  reset() {
    ++this.serial;this.pending=null;this.session=null;
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    this.listeners.forEach(remove=>remove());this.listeners=[];
  }
  request(target,{play=!this.video.paused,reason='user',allowRecovery=true}={}) {
    if (!this.session || !finite(target) || this.video.error) return false;
    if(this.timer!==null)this.clearTimer(this.timer);
    this.pending={session:this.session,target,play:Boolean(play),reason,allowRecovery:Boolean(allowRecovery),
      recoveryAttempt:userReasons.has(reason)?0:this.session.recoveryAttempt,
      requestedAt:this.now(),appliedAt:null,lastPosition:null,recovering:false};
    this.timer=this.setTimer(()=>this.#check(),250);
    this.#emit('waiting-metadata');this.#apply();return true;
  }
  #current(request) {return Boolean(request && this.pending===request && this.session===request.session);}
  #emit(state,detail='') {
    const request=this.pending;
    try {this.onStateChange?.({state,detail,target:request?.target ?? null,play:request?.play ?? false,
      reason:request?.reason || '',sourceKey:this.session?.sourceKey || ''});} catch { /* UI must not interrupt seeking. */ }
  }
  #finish(state,detail='') {
    this.#emit(state,detail);this.pending=null;
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
  }
  #apply() {
    const request=this.pending;
    if (!request || request.appliedAt!==null || request.recovering || this.video.readyState<1) return;
    const target=clampSeekTarget(this.video,request.target);
    if (target===null) return;
    try {
      const rangeLimited=Math.abs(target-request.target)>1;
      this.video.currentTime=target;
      request.target=target;request.appliedAt=this.now();request.lastPosition=Number(this.video.currentTime);
      this.#emit('seeking',rangeLimited?'seek-range-limited':'');
      if (!request.play) this.video.pause();
      else if(this.video.paused) {
        Promise.resolve(this.video.play()).catch(error=>{
          if(!this.#current(request))return;
          request.play=false;
          if(error?.name==='NotAllowedError')this.#emit('paused','interaction-required');
          else this.#finish('failed','playback-error');
        });
      }
    } catch {this.#finish('failed','seek-unavailable');}
  }
  #check() {
    const request=this.pending;if(!request || request.recovering)return;
    if(this.video.error){this.#finish('failed','media-error');return;}
    this.#apply();if(!this.#current(request))return;
    const elapsed=this.now()-(request.appliedAt ?? request.requestedAt);
    if(request.appliedAt===null){if(elapsed>=this.metadataMs)this.#finish('failed','metadata-timeout');return;}
    const position=Number(this.video.currentTime),ready=this.video.readyState>=2&&!this.video.seeking;
    if(ready && (!request.play&&Math.abs(position-request.target)<=1.5
      ||request.play&&Number.isFinite(position)&&position-request.lastPosition>=.15
      ||this.video.ended)) {this.#finish('ready');return;}
    if(elapsed<this.stallMs)return;
    if(!request.allowRecovery || request.recoveryAttempt>=1 || typeof this.onRecover!=='function') {this.#finish('failed','seek-stalled');return;}
    request.recovering=true;request.recoveryAttempt++;
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    this.#emit('recovering','seek-stalled');
    try {
      Promise.resolve(this.onRecover({target:request.target,play:request.play,
        sourceKey:request.session.sourceKey,recoveryAttempt:request.recoveryAttempt})).then(result=>{
        if(this.#current(request)&&result===false)this.#finish('failed','recovery-unavailable');
      }).catch(()=>{if(this.#current(request))this.#finish('failed','recovery-unavailable');});
    } catch {if(this.#current(request))this.#finish('failed','recovery-unavailable');}
  }
}
