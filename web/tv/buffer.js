// Buffer budgets belong to TV. Movie/episode policies remain independent.
export const TV_BUFFER_PROFILES=Object.freeze({
  balanced:{label:'Equilibrada',maxBufferLength:30,maxMaxBufferLength:60,liveSyncDurationCount:4,lowLatencyMode:false},
  stable:{label:'Mais estável',maxBufferLength:60,maxMaxBufferLength:120,liveSyncDurationCount:6,lowLatencyMode:false},
  low:{label:'Baixa latência',maxBufferLength:15,maxMaxBufferLength:30,liveSyncDurationCount:3,lowLatencyMode:true}
});
export function liveLoadPolicies(){
  const retry=()=>({maxNumRetry:1,retryDelayMs:500,maxRetryDelayMs:1000});
  return {
    manifestLoadPolicy:{default:{maxTimeToFirstByteMs:55000,maxLoadTimeMs:60000,timeoutRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0},errorRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0}}},
    // TV playlist responses observed at 3–7s cross the former 4s header
    // deadline. Allow that latency without changing the one-retry budget or
    // letting headers restart the finite total request deadline.
    playlistLoadPolicy:{default:{maxTimeToFirstByteMs:10000,maxLoadTimeMs:15000,timeoutRetry:retry(),errorRetry:retry()}},
    fragLoadPolicy:{default:{maxTimeToFirstByteMs:6000,maxLoadTimeMs:15000,timeoutRetry:retry(),errorRetry:retry()}},
    startFragPrefetch:true,initialLiveManifestSize:1
  };
}
export function liveBufferConfig(profile='balanced'){
  const selected=TV_BUFFER_PROFILES[profile]||TV_BUFFER_PROFILES.balanced;
  const {label,...config}=selected;
  return {...liveLoadPolicies(),...config,maxBufferSize:48*1024*1024};
}
export function livePlayerConfig(profile='balanced'){
  return {...liveBufferConfig(profile),backBufferLength:30,startLevel:-1,autoStartLoad:false,abrMaxWithRealBitrate:true,preserveManualLevelOnError:false};
}

/** Apply a live buffer profile using the current player's synchronization point. */
export function syncTVBufferPosition(tools){
  const current=tools.current,position=current?.hls?.liveSyncPosition;
  if(current?.item.kind!=='live'||!Number.isFinite(position)||position<=0||tools.video.readyState<1)return false;
  if(Math.abs(tools.video.currentTime-position)>1){current.intentionalSeekUntil=Date.now()+4000;tools.video.currentTime=position;tools.options.toast('Perfil aplicado. A posição ao vivo foi ajustada.');}
  return true;
}
