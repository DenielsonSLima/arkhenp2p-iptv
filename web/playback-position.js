import {isAdultItem} from './parental-classification.js';

const seconds=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const userSeekReasons=new Set(['user','opening','credits','restart']);

/** Preserve a pending target across a loader fallback, including pre-metadata errors. */
export function continuedPlaybackPosition({seekTarget,resumeTarget,resumePending=false,currentTime=0}={}){
  return seconds(seekTarget)??(resumePending?seconds(resumeTarget):null)??seconds(currentTime)??0;
}

/** Prevent source startup at zero from replacing a position still being resumed. */
export class PlaybackPositionGuard {
  constructor(){this.reset();}
  attach({resumeTime=0}={}){
    this.target=seconds(resumeTime)??0;
    this.pending=this.target>0;
    return this.pending;
  }
  observe({state,target,reason}={}){
    // An intentional seek, including "start over", replaces automatic resume.
    if(userSeekReasons.has(reason)){this.onUserSeek();return;}
    if(!this.pending)return;
    if(seconds(target)!==null)this.target=target;
    // currentTime may report the requested value before decoding resumes.
    // The seek controller owns confirmation; errors must retain the old record.
    if(state==='ready')this.pending=false;
  }
  canSave(time){return seconds(time)!==null&&!this.pending;}
  onUserSeek(){this.pending=false;this.target=null;}
  reset(){this.pending=false;this.target=null;}
}

/** Resolve an exact episode before falling back to the last title-level entry. */
export function resumePlaybackPosition({item,episode,episodeEntry,historyEntry,accountLibraryId,options={},categories=[]}={}) {
  if(!['movie','series'].includes(item?.kind))return 0;
  if(options.startFromBeginning)return 0;
  const explicit=seconds(options.resumeTime);if(explicit!==null)return explicit;
  // Explicit recovery targets above belong to the running player in RAM.
  // Private playback never resumes persisted title or episode history.
  if(isAdultItem(item,categories)||isAdultItem(episode,categories)||isAdultItem(episodeEntry,categories)||isAdultItem(episodeEntry?.item,categories)||isAdultItem(historyEntry,categories)||isAdultItem(historyEntry?.item,categories)||isAdultItem(historyEntry?.episode,categories))return 0;
  let saved=null;
  if(item.kind==='series'&&episode&&episodeEntry?.itemId===String(item.id)&&episodeEntry.episodeId===String(episode.id))saved=episodeEntry;
  else if((historyEntry?.libraryId===undefined||historyEntry.libraryId===accountLibraryId)&&
    historyEntry?.item?.kind===item.kind&&String(historyEntry.item.id)===String(item.id)&&
    (item.kind==='movie'||episode&&String(historyEntry.episode?.id)===String(episode.id)))saved=historyEntry;
  const time=seconds(saved?.time),duration=seconds(saved?.duration);
  return time!==null&&time>5&&!saved?.completed&&(!duration||time/duration<.95)?time:0;
}
