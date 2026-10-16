import {trackName,tracks} from './faixas.js';

/** TV audio controls use the active player only. They never open a stream. */
export function renderTVAudio(tools){
  const menu=tools.$('#audio-menu');menu.replaceChildren();
  const current=tools.current,hls=current?.hls,provided=hls?.audioTracks||[],native=tracks(tools.video.audioTracks);let label='Original';
  if(provided.length)provided.forEach((track,index)=>{
    const selected=hls.audioTrack===index,name=trackName(track,index);if(selected)label=name;
    tools.choice(menu,name,selected,()=>{if(tools.current!==current)return;hls.audioTrack=index;tools.$('#audio-label').textContent=name;});
  });
  else if(native.length)native.forEach((track,index)=>{
    const selected=track.enabled,name=trackName(track,index);if(selected)label=name;
    tools.choice(menu,name,selected,()=>{if(tools.current!==current)return;for(const candidate of native)candidate.enabled=candidate===track;tools.$('#audio-label').textContent=name;});
  });
  else{tools.choice(menu,'Áudio original',true,null,null,true);tools.note(menu,'O navegador não expôs outras faixas desta fonte.');}
  tools.$('#audio-label').textContent=label;
}

/** Keeps channel volume/source-transition state out of the page orchestrator. */
export class TVAudio{
  constructor({volumeMemory,audioProcessing}={}){Object.assign(this,{volumeMemory,audioProcessing});}
  begin(item,url){if(item?.kind!=='live')return;this.volumeMemory?.select(item);this.audioProcessing?.beginSourceChange({url,transport:'hls'});void this.audioProcessing?.requestActivation();}
  playing(){this.audioProcessing?.finishSourceChange();}
  reset(){this.volumeMemory?.reset();this.audioProcessing?.reset();}
}
