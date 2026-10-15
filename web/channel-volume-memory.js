const STORAGE_KEY='arkehn.channelVolume.v1';
const validVolume=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};

// Store only explicit slider adjustments. Restoring a channel must never teach
// another channel's volume, or overwrite the user's mute setting.
export class ChannelVolumeMemory {
  constructor({video,storage=browserStorage(),getNamespace=()=>'',limit=250}={}){
    this.video=video;this.storage=storage;this.getNamespace=getNamespace;this.limit=limit;
    this.currentKey=null;this.enabled=true;this.volumes=new Map();
    this.lastUserVolume=validVolume(video?.volume)?video.volume:1;
    try{
      const saved=JSON.parse(storage?.getItem(STORAGE_KEY)||'{}');
      this.enabled=saved.enabled!==false;
      if(validVolume(saved.lastUserVolume))this.lastUserVolume=saved.lastUserVolume;
      for(const entry of Array.isArray(saved.volumes)?saved.volumes.slice(-limit):[]){
        if(Array.isArray(entry)&&typeof entry[0]==='string'&&entry[0].length<=200&&validVolume(entry[1]))this.volumes.set(entry[0],entry[1]);
      }
    }catch{/* Local preferences are optional. */}
  }
  persist(){try{this.storage?.setItem(STORAGE_KEY,JSON.stringify({enabled:this.enabled,lastUserVolume:this.lastUserVolume,volumes:[...this.volumes]}));}catch{/* Playback must continue when storage is full. */}}
  setEnabled(value){this.enabled=Boolean(value);this.persist();}
  getPreferences(){const prefix=`${String(this.getNamespace()).slice(0,160)}:`;return {enabled:this.enabled,lastUserVolume:this.lastUserVolume,volumes:[...this.volumes].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>[key.slice(prefix.length),value])};}
  setPreferences(value={}){
    const prefix=`${String(this.getNamespace()).slice(0,160)}:`;
    if(typeof value.enabled==='boolean')this.enabled=value.enabled;
    if(validVolume(value.lastUserVolume))this.lastUserVolume=value.lastUserVolume;
    if(Array.isArray(value.volumes)){
      for(const key of this.volumes.keys())if(key.startsWith(prefix))this.volumes.delete(key);
      for(const entry of value.volumes.slice(-this.limit))if(Array.isArray(entry)&&/^\d{1,12}$/.test(String(entry[0]))&&validVolume(entry[1]))this.volumes.set(prefix+entry[0],entry[1]);
    }
    while(this.volumes.size>this.limit)this.volumes.delete(this.volumes.keys().next().value);this.persist();
  }
  select(item){
    this.currentKey=item?.kind==='live'&&/^\d{1,12}$/.test(String(item.id))?`${String(this.getNamespace()).slice(0,160)}:${item.id}`:null;
    if(!this.enabled||!this.currentKey)return false;
    const volume=this.volumes.get(this.currentKey)??this.lastUserVolume;
    if(!validVolume(volume))return false;
    try{this.video.volume=volume;return Math.abs(this.video.volume-volume)<.01;}catch{return false;}
  }
  remember(volume){
    if(!validVolume(volume))return;
    this.lastUserVolume=volume;
    if(this.enabled&&this.currentKey){
      this.volumes.delete(this.currentKey);this.volumes.set(this.currentKey,volume);
      while(this.volumes.size>this.limit)this.volumes.delete(this.volumes.keys().next().value);
    }
    this.persist();
  }
  reset(){this.currentKey=null;}
}
