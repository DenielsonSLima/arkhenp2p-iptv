export const SERIES_BUFFER_PROFILES=Object.freeze({
  balanced:Object.freeze({label:'Equilibrada',description:'Mantém uma margem de vídeo sem acumular carregamento excessivo.',maxBufferLength:30,maxMaxBufferLength:60}),
  stable:Object.freeze({label:'Mais estável',description:'Mantém mais vídeo disponível adiante.',maxBufferLength:60,maxMaxBufferLength:120})
});
export const seriesBufferProfile=value=>Object.hasOwn(SERIES_BUFFER_PROFILES,value)?value:'balanced';

export function seriesLoadPolicies(){
  const retry=()=>({maxNumRetry:1,retryDelayMs:500,maxRetryDelayMs:1000});
  return {
    manifestLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0},errorRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0}}},
    playlistLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:retry(),errorRetry:retry()}},
    fragLoadPolicy:{default:{maxTimeToFirstByteMs:6000,maxLoadTimeMs:15000,timeoutRetry:retry(),errorRetry:retry()}},startFragPrefetch:true
  };
}
export function seriesBufferConfig(profile='balanced'){
  const {label,description,...config}=SERIES_BUFFER_PROFILES[seriesBufferProfile(profile)];
  return {...seriesLoadPolicies(),...config,lowLatencyMode:false,maxBufferSize:48*1024*1024};
}
export function seriesPlayerConfig(profile='balanced'){
  return {...seriesBufferConfig(profile),backBufferLength:60,startLevel:-1,autoStartLoad:true,abrMaxWithRealBitrate:true,preserveManualLevelOnError:false};
}

/** Episode buffering never seeks to a live synchronization position. */
export function applySeriesBuffer(tools,profile=tools.profiles?.vod){
  if(tools.current?.item.kind!=='series')return false;
  tools.bufferMode=seriesBufferProfile(profile);
  if(!tools.current.hls?.config)return false;
  Object.assign(tools.current.hls.config,seriesBufferConfig(tools.bufferMode));return true;
}
export function renderSeriesBuffer(tools){
  const current=tools.current;if(current?.item.kind!=='series')return false;
  const menu=tools.$('#buffer-menu');menu.replaceChildren();const hls=current.hls,profile=seriesBufferProfile(tools.bufferMode);
  tools.$('#buffer-label').textContent=hls?SERIES_BUFFER_PROFILES[profile].label:'Automática';
  for(const [key,mode] of Object.entries(SERIES_BUFFER_PROFILES))tools.choice(menu,mode.label,key===profile,()=>{if(tools.current===current)tools.setProfile('vod',key);},mode.description,!hls);
  tools.note(menu,hls?'O perfil ajusta os próximos trechos carregados e conserva a posição do episódio.':'Nesta fonte, o navegador gerencia o carregamento automaticamente.');return true;
}
