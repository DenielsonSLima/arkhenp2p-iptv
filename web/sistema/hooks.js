/** Vanilla DOM lifecycle. Every event and queued focus belongs to its view. */
export function createDOMHooks(){
  const cleanups=new Set();let disposed=false;
  const add=cleanup=>{
    if(disposed){cleanup();return()=>{};}
    cleanups.add(cleanup);return()=>{if(cleanups.delete(cleanup))cleanup();};
  };
  return {
    listen(target,type,listener,options){
      if(disposed||!target?.addEventListener)return()=>{};
      target.addEventListener(type,listener,options);
      return add(()=>target.removeEventListener(type,listener,options));
    },
    frame(callback){
      if(disposed)return()=>{};
      const schedule=callback=>globalThis.requestAnimationFrame?globalThis.requestAnimationFrame(callback):setTimeout(callback,0);
      const cancel=id=>globalThis.cancelAnimationFrame?globalThis.cancelAnimationFrame(id):clearTimeout(id);
      let cleanup;
      const id=schedule(()=>{cleanups.delete(cleanup);if(!disposed)callback();});
      cleanup=()=>cancel(id);return add(cleanup);
    },
    add,
    dispose(){if(disposed)return;disposed=true;for(const cleanup of [...cleanups]){cleanups.delete(cleanup);cleanup();}}
  };
}
