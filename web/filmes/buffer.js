export const MOVIE_BUFFER_PROFILES=Object.freeze({
  balanced:Object.freeze({label:'Equilibrada',description:'Mantém uma margem de vídeo sem acumular carregamento excessivo.',maxBufferLength:30,maxMaxBufferLength:60}),
  stable:Object.freeze({label:'Mais estável',description:'Mantém mais vídeo disponível adiante.',maxBufferLength:60,maxMaxBufferLength:120})
});
export const movieBufferProfile=value=>Object.hasOwn(MOVIE_BUFFER_PROFILES,value)?value:'balanced';

export function movieLoadPolicies(){
  const retry=()=>({maxNumRetry:1,retryDelayMs:500,maxRetryDelayMs:1000});
  return {
    manifestLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0},errorRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0}}},
    playlistLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:retry(),errorRetry:retry()}},
    fragLoadPolicy:{default:{maxTimeToFirstByteMs:6000,maxLoadTimeMs:15000,timeoutRetry:retry(),errorRetry:retry()}},startFragPrefetch:true
  };
}
export function movieBufferConfig(profile='balanced'){
  const {label,description,...config}=MOVIE_BUFFER_PROFILES[movieBufferProfile(profile)];
  return {...movieLoadPolicies(),...config,lowLatencyMode:false,maxBufferSize:48*1024*1024};
}
export function moviePlayerConfig(profile='balanced'){
  return {...movieBufferConfig(profile),backBufferLength:60,startLevel:-1,autoStartLoad:true,abrMaxWithRealBitrate:true,preserveManualLevelOnError:false};
}

/** Updating a VOD buffer never jumps to a live synchronization point. */
export function applyMovieBuffer(tools,profile=tools.profiles?.vod){
  if(tools.current?.item.kind!=='movie')return false;
  tools.bufferMode=movieBufferProfile(profile);
  if(!tools.current.hls?.config)return false;
  Object.assign(tools.current.hls.config,movieBufferConfig(tools.bufferMode));return true;
}
export function renderMovieBuffer(tools){
  const current=tools.current;if(current?.item.kind!=='movie')return false;
  const menu=tools.$('#buffer-menu');menu.replaceChildren();const hls=current.hls,profile=movieBufferProfile(tools.bufferMode);
  tools.$('#buffer-label').textContent=hls?MOVIE_BUFFER_PROFILES[profile].label:'Automática';
  for(const [key,mode] of Object.entries(MOVIE_BUFFER_PROFILES))tools.choice(menu,mode.label,key===profile,()=>{if(tools.current===current)tools.setProfile('vod',key);},mode.description,!hls);
  tools.note(menu,hls?'O perfil ajusta os próximos trechos carregados e conserva a posição do filme.':'Nesta fonte, o navegador gerencia o carregamento automaticamente.');return true;
}
