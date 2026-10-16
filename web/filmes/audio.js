const tracks=value=>{try{return Array.from(value||[]);}catch{return [];}};
const trackName=(track,index)=>track.name||track.label||track.lang||track.language||`Faixa ${index+1}`;

/** Movie tracks belong to the existing media element/HLS instance. */
export function renderMovieAudio(tools){
  const current=tools.current;if(current?.item.kind!=='movie')return false;
  const menu=tools.$('#audio-menu');menu.replaceChildren();
  const hls=current.hls,provided=hls?.audioTracks||[],native=tracks(tools.video.audioTracks);let label='Original';
  if(provided.length)provided.forEach((track,index)=>{
    const selected=hls.audioTrack===index,name=trackName(track,index);if(selected)label=name;
    tools.choice(menu,name,selected,()=>{if(tools.current!==current)return;hls.audioTrack=index;tools.$('#audio-label').textContent=name;});
  });
  else if(native.length)native.forEach((track,index)=>{
    const selected=track.enabled,name=trackName(track,index);if(selected)label=name;
    tools.choice(menu,name,selected,()=>{if(tools.current!==current)return;for(const candidate of native)candidate.enabled=candidate===track;tools.$('#audio-label').textContent=name;});
  });
  else{tools.choice(menu,'Áudio original',true,null,null,true);tools.note(menu,'O navegador não expôs outras faixas deste filme.');}
  tools.$('#audio-label').textContent=label;return true;
}

/** Source transition only. The shared owner keeps its one audio graph and
 * preferences; choosing a movie stops channel-specific volume association. */
export class MovieAudio{
  constructor({volumeMemory,audioProcessing}={}){Object.assign(this,{volumeMemory,audioProcessing});this.current=null;}
  begin(item,url,{transport='file',isCurrent=()=>true}={}){
    if(item?.kind!=='movie'||!isCurrent())return false;
    this.current={item,isCurrent};this.volumeMemory?.select(item);
    this.audioProcessing?.beginSourceChange({url,transport});
    void Promise.resolve(this.audioProcessing?.requestActivation()).catch(()=>{});return true;
  }
  playing(){if(!this.current?.isCurrent())return false;this.audioProcessing?.finishSourceChange();return true;}
  reset(){this.current=null;this.volumeMemory?.reset();this.audioProcessing?.reset();}
}
