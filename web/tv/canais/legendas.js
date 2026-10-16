import {trackName,tracks} from './faixas.js';

export function disableTVSubtitles(tools){
  if(tools.current?.hls){tools.current.hls.subtitleTrack=-1;tools.current.hls.subtitleDisplay=false;}
  for(const track of tracks(tools.video.textTracks))if(['subtitles','captions'].includes(track.kind))track.mode='disabled';
}
export function renderTVSubtitles(tools){
  const menu=tools.$('#subtitle-menu');menu.replaceChildren();
  const current=tools.current,hls=current?.hls,provided=hls?.subtitleTracks||[],native=tracks(tools.video.textTracks).filter(track=>['subtitles','captions'].includes(track.kind));
  const active=provided.some((_,index)=>hls.subtitleDisplay&&hls.subtitleTrack===index)||native.some(track=>track.mode==='showing');
  tools.choice(menu,'Desativadas',!active,()=>{if(tools.current!==current)return;tools.subtitleSelection=null;disableTVSubtitles(tools);renderTVSubtitles(tools);});
  let selectedName='Desativadas';
  provided.forEach((track,index)=>{
    const selected=hls.subtitleDisplay&&hls.subtitleTrack===index,label=trackName(track,index);if(selected)selectedName=label;
    tools.choice(menu,label,selected,()=>{if(tools.current!==current)return;disableTVSubtitles(tools);hls.subtitleTrack=index;hls.subtitleDisplay=true;tools.subtitleSelection={type:'hls',index};tools.$('#subtitle-label').textContent=label;tools.subtitleLayout?.refresh();});
  });
  native.forEach((track,index)=>{
    const local=tools.localTracks.find(entry=>entry.element.track===track);
    if(!local&&provided.some(value=>(value.name||value.lang)===(track.label||track.language)))return;
    const selected=track.mode==='showing',label=local?local.name:trackName(track,index);if(selected)selectedName=label;
    tools.choice(menu,label,selected,()=>{if(tools.current!==current)return;disableTVSubtitles(tools);track.mode='showing';tools.subtitleSelection={type:'native',track};tools.$('#subtitle-label').textContent=label;tools.subtitleLayout?.refresh();});
  });
  if(!provided.length&&!native.length)tools.note(menu,'A fonte não disponibilizou legendas. Você pode adicionar um arquivo.');
  tools.$('#subtitle-label').textContent=selectedName;
}
