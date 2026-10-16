const STORAGE_KEY='arkhen.player-engine.v1';
const normalize=value=>value==='shaka'?'shaka':'current';
const listeners=new Set();
let selected='current';
try{selected=normalize(localStorage.getItem(STORAGE_KEY));}catch{}

// Device preference: deliberately independent of account/catalog synchronization.
export const playerEnginePreference={
  get(){return selected;},
  set(value){
    const next=normalize(value);
    if(next===selected)return selected;
    // Keep the previous choice when the browser cannot persist the change.
    localStorage.setItem(STORAGE_KEY,next);
    selected=next;
    for(const listener of listeners)try{listener(selected);}catch{}
    return selected;
  },
  subscribe(listener){
    if(typeof listener!=='function')return()=>{};
    listeners.add(listener);return()=>listeners.delete(listener);
  }
};
