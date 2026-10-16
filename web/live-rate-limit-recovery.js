// One bounded retry belongs to one live HLS instance. PlayerTools.reset clears
// both this timer and its cleanup, so a previous channel can never resume here.
export function liveRateLimitRecovery({isCurrent,tools,fail}){
  const current=tools.current,hls=current?.hls;
  if(current?.item?.kind!=='live'||!hls)return null;
  let timer=null,retryUsed=false,closed=false;
  const active=()=>!closed&&isCurrent()&&tools.current===current&&!current.failed&&current.hls===hls;
  const cancelTimer=()=>{
    if(timer!==null){clearTimeout(timer);tools.timers?.delete(timer);if(current.recoveryTimer===timer)current.recoveryTimer=null;timer=null;}
    current.rateLimitedUntil=0;
  };
  const destroyEvent=globalThis.Hls?.Events?.DESTROYING||globalThis.window?.Hls?.Events?.DESTROYING;
  const cleanup=()=>{closed=true;cancelTimer();if(destroyEvent)hls.off?.(destroyEvent,cleanup);};
  tools.listeners?.push(cleanup);
  if(destroyEvent)hls.on?.(destroyEvent,cleanup);
  const status=message=>{const node=tools.$?.('#player-status');if(node)node.textContent=message;};
  const terminal=message=>{
    cleanup();
    try{hls.stopLoad();}catch{/* Teardown can already have stopped this instance. */}
    if(isCurrent()&&tools.current===current)fail(message,{terminalService:true});
  };
  return {
    waiting:()=>active()&&timer!==null,
    handle(limit){
      if(!active())return;
      // Stop even a nonfatal 429 before HLS or the generic recovery schedules
      // a short retry. Also cancel any earlier generic network recovery.
      try{hls.stopLoad();}catch{/* A destroyed transport cannot be restarted. */}
      if(current.recoveryTimer&&current.recoveryTimer!==timer){clearTimeout(current.recoveryTimer);tools.timers?.delete(current.recoveryTimer);current.recoveryTimer=null;}
      if(limit.retryAfterMs===null){terminal('O serviço limitou esta transmissão por um intervalo maior. Aguarde antes de tentar novamente.');return;}
      if(!current.started){terminal(`O serviço limitou a abertura deste canal. Aguarde ${Math.ceil(limit.waitMs/1000)} segundos antes de tentar novamente.`);return;}
      if(timer!==null)cancelTimer();
      else if(retryUsed){terminal('O serviço continua limitando esta transmissão. Aguarde antes de tentar novamente.');return;}
      retryUsed=true;current.rateLimitedUntil=Date.now()+limit.retryAfterMs;
      status(`O serviço limitou esta transmissão. Aguardando ${Math.ceil(limit.retryAfterMs/1000)} segundos para retomar…`);
      timer=setTimeout(()=>{
        const expired=timer;timer=null;tools.timers?.delete(expired);if(current.recoveryTimer===expired)current.recoveryTimer=null;current.rateLimitedUntil=0;
        if(active()){
          status('Retomando a transmissão…');
          try{hls.startLoad();}catch{terminal('Não foi possível retomar esta transmissão. Aguarde antes de tentar novamente.');}
        }
      },limit.retryAfterMs);
      current.recoveryTimer=timer;tools.timers?.add(timer);
    }
  };
}
