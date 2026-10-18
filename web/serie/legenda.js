export const SERIES_SUBTITLE_MAX_BYTES=2*1024*1024;
const tracks=value=>{try{return Array.from(value||[]);}catch{return [];}};
const trackName=(track,index)=>track.name||track.label||track.lang||track.language||`Faixa ${index+1}`;

export function disableSeriesSubtitles(tools){
  const current=tools.current;if(current?.item.kind!=='series')return false;
  current.seriesSubtitleRequest=null;
  const hls=current.hls;if(hls){hls.subtitleTrack=-1;hls.subtitleDisplay=false;}
  for(const track of tracks(tools.video.textTracks))if(['subtitles','captions'].includes(track.kind))track.mode='disabled';
  return true;
}

export function renderSeriesSubtitles(tools){
  const current=tools.current;if(current?.item.kind!=='series')return false;
  const menu=tools.$('#subtitle-menu');menu.replaceChildren();
  const hls=current.hls,provided=hls?.subtitleTracks||[],native=tracks(tools.video.textTracks).filter(track=>['subtitles','captions'].includes(track.kind));
  const active=provided.some((_,index)=>hls.subtitleDisplay&&hls.subtitleTrack===index)||native.some(track=>track.mode==='showing');
  tools.choice(menu,'Desativadas',!active,()=>{if(tools.current!==current)return;tools.subtitleSelection=null;disableSeriesSubtitles(tools);renderSeriesSubtitles(tools);});
  let selectedName='Desativadas';
  provided.forEach((track,index)=>{
    const selected=hls.subtitleDisplay&&hls.subtitleTrack===index,label=trackName(track,index);if(selected)selectedName=label;
    tools.choice(menu,label,selected,()=>{if(tools.current!==current)return;disableSeriesSubtitles(tools);hls.subtitleTrack=index;hls.subtitleDisplay=true;tools.subtitleSelection={type:'hls',index};tools.$('#subtitle-label').textContent=label;tools.subtitleLayout?.refresh();});
  });
  native.forEach((track,index)=>{
    const local=tools.localTracks.find(entry=>entry.element.track===track);
    if(!local&&provided.some(value=>(value.name||value.lang)===(track.label||track.language)))return;
    const selected=track.mode==='showing',label=local?local.name:trackName(track,index);if(selected)selectedName=label;
    tools.choice(menu,label,selected,()=>{if(tools.current!==current)return;disableSeriesSubtitles(tools);track.mode='showing';tools.subtitleSelection={type:'native',track};tools.$('#subtitle-label').textContent=label;tools.subtitleLayout?.refresh();});
  });
  if(!provided.length&&!native.length)tools.note(menu,'Este episódio não disponibilizou legendas. Você pode adicionar um arquivo .srt ou .vtt.');
  tools.$('#subtitle-label').textContent=selectedName;return true;
}

/** The shared PlayerTools owns track URLs/cleanup. Each asynchronous read/load
 * is tied to one episode's current record and cannot affect its successor. */
export async function addSeriesSubtitle(tools,input,{toVtt}={}){
  const file=input.files?.[0],current=tools.current;input.value='';
  if(!file||current?.item.kind!=='series')return false;
  const request=Symbol('series-subtitle');current.seriesSubtitleRequest=request;
  const owns=()=>tools.current===current&&current.seriesSubtitleRequest===request;
  let local=null;
  try{
    if(file.size>SERIES_SUBTITLE_MAX_BYTES)throw new Error('Use um arquivo de legenda de até 2 MB.');
    if(typeof toVtt!=='function')throw new Error('Não foi possível preparar esta legenda.');
    const extension=file.name.split('.').pop().toLowerCase(),text=await file.text();
    if(!owns())return false;
    const vtt=toVtt(text,extension),url=URL.createObjectURL(new Blob([vtt],{type:'text/vtt'}));
    const element=tools.video.ownerDocument.createElement('track');element.kind='subtitles';element.label=file.name;element.srclang='pt-BR';element.src=url;
    local={element,url,name:file.name};tools.localTracks.push(local);
    element.addEventListener('load',()=>{
      if(!owns()||!tools.localTracks.includes(local))return;
      disableSeriesSubtitles(tools);element.track.mode='showing';tools.subtitleSelection={type:'native',track:element.track};
      tools.subtitleLayout?.refresh();renderSeriesSubtitles(tools);tools.options.toast('Legenda adicionada');
    },{once:true});
    element.addEventListener('error',()=>{if(owns()&&tools.localTracks.includes(local))tools.options.toast('Não foi possível ler esta legenda. Confira o arquivo.');},{once:true});
    tools.video.append(element);if(element.track)element.track.mode='hidden';renderSeriesSubtitles(tools);return true;
  }catch(error){
    if(local){local.element.remove();URL.revokeObjectURL(local.url);const index=tools.localTracks.indexOf(local);if(index>=0)tools.localTracks.splice(index,1);}
    if(owns())tools.options.toast(error.message);return false;
  }
}
