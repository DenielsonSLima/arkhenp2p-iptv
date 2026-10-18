const MAX_PLAYLISTS=8,MAX_SEGMENTS=256,MAX_URL_LENGTH=8192,MAX_MANIFEST_BYTES=4*1024*1024;
const safeInteger=value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const unsupported=/^#EXT-X-(?:KEY:|SESSION-KEY:|MAP:|BYTERANGE:|DEFINE:|PART(?:-INF)?:|PRELOAD-HINT:|SERVER-CONTROL:|SKIP:|RENDITION-REPORT:|PREFETCH:|I-FRAMES-ONLY$)/;

// The observed web-OTT token rotates for an unchanged segment. Exclude only
// that literal, single, nonempty parameter from LOCAL identity; preserve every
// other query byte and its ordering. The upstream address is never changed.
function semanticURL(value){
  if(typeof value!=='string'||value.length>MAX_URL_LENGTH)return null;
  let url;try{url=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  const retained=[];let count=0;
  for(const pair of url.search.slice(1).split('&')){
    const equal=pair.indexOf('='),name=equal<0?pair:pair.slice(0,equal);
    if(name==='token'){if(equal<0||!pair.slice(equal+1))return null;count++;}
    else retained.push(pair);
  }
  if(count!==1)return null;
  return url.href.slice(0,url.href.indexOf('?'))+(retained.length?'?'+retained.join('&'):'')+url.hash;
}

function mediaSegments(text,base){
  if(typeof text!=='string'||text.length>MAX_MANIFEST_BYTES||!text.trimStart().startsWith('#EXTM3U')||text.includes('{$'))return null;
  const segments=new Map();let sequence=null,firstSequence=null,discontinuity=0,firstDiscontinuity=0,duration=null,sequenceTags=0,discontinuityTags=0;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();if(!line)continue;if(unsupported.test(line))return null;
    if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){
      if(++sequenceTags!==1||segments.size)return null;
      sequence=safeInteger(line.slice(22));if(sequence===null)return null;firstSequence=sequence;
    }else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')){
      if(++discontinuityTags!==1||segments.size)return null;
      discontinuity=safeInteger(line.slice(30));if(discontinuity===null)return null;firstDiscontinuity=discontinuity;
    }else if(line==='#EXT-X-DISCONTINUITY'){
      if(!Number.isSafeInteger(++discontinuity))return null;
    }else if(line.startsWith('#EXTINF:')){
      if(duration!==null)return null;const value=line.slice(8).split(',')[0];
      duration=/^\d+(?:\.\d+)?$/.test(value)?Number(value):null;
      if(!(duration>0&&duration<=86400))return null;
    }
    if(line.startsWith('#'))continue;
    if(duration===null||sequence===null||segments.size>=MAX_SEGMENTS)return null;
    let source;try{source=new URL(line,base).href;}catch{return null;}
    const semantic=semanticURL(source);if(semantic===null)return null;
    const key=`${sequence}:${discontinuity}`;if(segments.has(key))return null;
    segments.set(key,{source,semantic,duration,sequence,discontinuity});
    if(!Number.isSafeInteger(++sequence))return null;duration=null;
  }
  if(!segments.size||duration!==null)return null;
  return{segments,sequence:firstSequence,discontinuity:firstDiscontinuity};
}

/** One instance per account client. Owner is its private, immutable completed
 * web selection (channel/source/attempt). No generic provider can opt in by URL.
 * Epochs protect rewinds and changed durations; bounded snapshots hold no bytes. */
export class WebLiveSegmentIdentity {
  #owner=null;#playlists=new Map();#epoch=0;
  exportRuntimeState(){return {version:1,epoch:this.#epoch,playlists:new Map([...this.#playlists].map(([base,state])=>[base,{...state,durations:new Map(state.durations)}]))};}
  restoreRuntimeState(state,{owner=null}={}){
    this.reset();
    if(state?.version!==1)throw new Error('Estado de identidade de segmentos inválido.');
    this.#epoch=state.epoch||0;
    if(owner){this.#owner=owner;this.#playlists=new Map([...state.playlists].slice(-MAX_PLAYLISTS).map(([base,value])=>[base,{...value,durations:new Map(value.durations)}]));}
    return this;
  }
  reset(){this.#owner=null;this.#playlists.clear();}
  manifest({text,base,owner}){
    if(!owner||typeof owner!=='object'||typeof base!=='string'||base.length>MAX_URL_LENGTH)return null;
    if(owner!==this.#owner){this.reset();this.#owner=owner;}
    const parsed=mediaSegments(text,base);
    if(!parsed){this.#playlists.delete(base);return null;}
    let state=this.#playlists.get(base);
    const rewound=state&&(parsed.sequence<state.sequence||parsed.discontinuity<state.discontinuity);
    const changedDuration=state&&[...parsed.segments].some(([key,value])=>state.durations.has(key)&&state.durations.get(key)!==value.duration);
    if(!state||rewound||changedDuration)state={epoch:++this.#epoch};
    Object.assign(state,{sequence:parsed.sequence,discontinuity:parsed.discontinuity,durations:new Map([...parsed.segments].map(([key,value])=>[key,value.duration]))});
    this.#playlists.delete(base);this.#playlists.set(base,state);
    if(this.#playlists.size>MAX_PLAYLISTS)this.#playlists.delete(this.#playlists.keys().next().value);
    return(source,sequence,discontinuity,duration)=>{
      if(this.#owner!==owner||this.#playlists.get(base)!==state)return null;
      const segment=parsed.segments.get(`${sequence}:${discontinuity}`);
      return segment?.source===source&&segment.duration===duration
        ?JSON.stringify([state.epoch,base,sequence,discontinuity,duration,segment.semantic]):null;
    };
  }
}
