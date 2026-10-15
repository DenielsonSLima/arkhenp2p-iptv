/** The launcher owns this child only. IPC provides graceful cleanup on Windows,
 * where sending SIGINT through ChildProcess.kill can terminate immediately. */
export const P2P_SHUTDOWN_MESSAGE='arkhen:p2p:shutdown';
export function requestP2PWebShutdown(child,{graceMs=20000,forceMs=4000,schedule=setTimeout,cancel=clearTimeout}={}){
  if(!child||child.exitCode!==null)return()=>{};
  let stopped=false,terminate,force;
  const cleanup=()=>{if(stopped)return;stopped=true;cancel(terminate);cancel(force);child.off('exit',cleanup);child.off('error',cleanup);};
  const kill=signal=>{if(!stopped&&child.exitCode===null)try{child.kill(signal);}catch{}};
  child.once('exit',cleanup);child.once('error',cleanup);
  terminate=schedule(()=>kill('SIGTERM'),Math.max(1,graceMs));
  force=schedule(()=>kill('SIGKILL'),Math.max(1,graceMs)+Math.max(1,forceMs));
  terminate?.unref?.();force?.unref?.();
  if(child.connected&&typeof child.send==='function')try{child.send({type:P2P_SHUTDOWN_MESSAGE},()=>{});}catch{/* The bounded fallback still owns only this child. */}
  return cleanup;
}

/** Used only by the executable server. A normal npm start has no private IPC
 * channel and cannot accept launcher control messages. */
export function wireP2PServerShutdown(server,{hostProcess=process,onError=()=>{hostProcess.exitCode=1;}}={}){
  const owned=hostProcess.env?.ARKHEN_P2P_LAUNCHER==='1'&&typeof hostProcess.send==='function';
  const shutdown=async()=>{try{await server.shutdown();}catch(error){onError(error);}finally{if(owned&&hostProcess.connected)hostProcess.disconnect();}};
  hostProcess.once('SIGINT',shutdown);hostProcess.once('SIGTERM',shutdown);
  if(owned){hostProcess.on('message',message=>{if(message?.type===P2P_SHUTDOWN_MESSAGE)void shutdown();});hostProcess.once('disconnect',shutdown);}
  return shutdown;
}
