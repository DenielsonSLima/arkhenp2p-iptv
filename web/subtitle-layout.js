const subtitleTrack = track => ['subtitles','captions'].includes(track?.kind);
const array = value => {try {return Array.from(value || []);} catch {return [];}};

// Cue positioning belongs to WebVTT, not ordinary CSS. Keep provider/imported
// text and timing intact while removing right-aligned regions and large boxes.
export function centerSubtitleCue(cue, {controlsVisible=false}={}) {
  if (!cue || typeof cue!=='object') return false;
  try {if (typeof cue.text!=='string') return false;} catch {return false;}
  const settings={region:null,vertical:'',snapToLines:true,line:controlsVisible ? -5 : -2,lineAlign:'end',position:50,positionAlign:'center',size:86,align:'center'};
  let changed=false;
  for (const [key,value] of Object.entries(settings)) {
    try {if (key in cue && cue[key]!==value) {cue[key]=value;changed=true;}} catch {/* Some native/in-band cue properties are read-only. */}
  }
  return changed;
}

export class SubtitleLayout {
  constructor({video,getControlsRoot}={}) {
    this.video=video;this.getControlsRoot=getControlsRoot || (()=>video?.closest?.('.immersive-stage')?.querySelector('.ip-root'));
    this.active=false;this.tracks=new Map();this.disposers=[];this.observer=null;
  }
  listen(target,event,callback) {
    target?.addEventListener?.(event,callback);const remove=()=>target?.removeEventListener?.(event,callback);this.disposers.push(remove);return remove;
  }
  controlsVisible() {
    const root=this.getControlsRoot();return Boolean(root && !root.hidden && !root.classList?.contains('ip-hidden'));
  }
  attach() {
    this.stop();if (!this.video) return;this.active=true;
    const list=this.video.textTracks;
    for (const event of ['addtrack','removetrack','change']) this.listen(list,event,()=>this.refresh());
    for (const event of ['loadedmetadata','loadeddata','resize']) this.listen(this.video,event,()=>this.refresh());
    const root=this.getControlsRoot();
    if (root && typeof globalThis.MutationObserver==='function') {
      this.observer=new globalThis.MutationObserver(()=>this.refreshActive());this.observer.observe(root,{attributes:true,attributeFilter:['class','hidden']});
    }
    this.refresh();
  }
  syncTracks() {
    if (!this.active) return;
    const present=new Set(array(this.video.textTracks).filter(subtitleTrack));
    for (const [track,remove] of this.tracks) if (!present.has(track)) {remove();this.tracks.delete(track);}
    for (const track of present) if (!this.tracks.has(track)) {
      const callback=()=>this.applyTrack(track,true);track.addEventListener?.('cuechange',callback);
      this.tracks.set(track,()=>track.removeEventListener?.('cuechange',callback));this.applyTrack(track);
    }
  }
  applyCues(cues) {
    if (!this.active) return;const controlsVisible=this.controlsVisible();
    for (const cue of array(cues)) centerSubtitleCue(cue,{controlsVisible});
  }
  applyTrack(track,activeOnly=false) {
    try {this.applyCues(activeOnly ? track.activeCues : track.cues);} catch {/* A native track may not expose its cues. */}
  }
  refresh(cues=null) {
    if (!this.active) return;this.syncTracks();
    if (cues) this.applyCues(cues);else for (const track of this.tracks.keys()) this.applyTrack(track);
  }
  refreshActive() {
    if (!this.active) return;this.syncTracks();for (const track of this.tracks.keys()) this.applyTrack(track,true);
  }
  stop() {
    this.active=false;this.observer?.disconnect();this.observer=null;
    for (const remove of this.disposers) remove();this.disposers=[];
    for (const remove of this.tracks.values()) remove();this.tracks.clear();
  }
}
