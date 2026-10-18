import {artworkURL,fallbackArtworkURL} from './channel-artwork.js';

const records=new WeakMap();

/** Keep transient proxy failures recoverable without rebuilding whole shelves. */
export function bindArtworkImage(picture,{source,fallback='',getScope=()=>'',onFailure=()=>{}}={}){
  const initial=artworkURL(source),scope=getScope();
  const record={scope,getScope,source:initial,fallback:artworkURL(fallback),fallbackTried:false,retries:0,timer:null,failed:false,reported:false};records.set(picture,record);
  const current=()=>records.get(picture)===record&&getScope()===scope;
  const visible=()=>!(picture.ownerDocument||globalThis.document)?.hidden&&!picture.closest?.('[hidden]');
  const request=value=>{
    record.failed=false;picture.classList.remove('image-failed');picture.style.removeProperty('display');picture.src=value;
  };
  const recover=()=>{
    const recovery=fallbackArtworkURL(record.source,record.fallback);
    if(record.fallbackTried||!recovery)return false;
    record.fallbackTried=true;record.source=recovery;request(recovery);return true;
  };
  const report=()=>{
    if(record.reported)return;
    record.reported=true;try{onFailure(record.source);}catch{/* Recovery of another card cannot break this image. */}
  };
  const load=()=>{
    if(!current())return;
    clearTimeout(record.timer);record.timer=null;record.failed=false;
    picture.classList.remove('image-failed');picture.style.removeProperty('display');picture.parentElement?.classList.add('artwork-ready');
  };
  const retry=delay=>{
    if(record.timer!==null||record.retries>=3||!current()||!visible()||!picture.isConnected)return false;
    record.timer=setTimeout(()=>{
      record.timer=null;if(!current()||!picture.isConnected||!visible())return;
      if(recover())return;
      report();record.retries++;
      const separator=record.source.includes('?')?'&':'?';request(`${record.source}${separator}artwork_retry=${record.retries}`);
    },delay);
    return true;
  };
  record.retry=retry;
  record.retryable=()=>record.source.startsWith('/api/')||!record.fallbackTried&&!!fallbackArtworkURL(record.source,record.fallback);
  picture.addEventListener('load',load);
  picture.addEventListener('error',()=>{
    if(!current())return;
    if(visible()&&recover())return;
    record.failed=true;picture.parentElement?.classList.remove('artwork-ready');picture.classList.add('image-failed');picture.style.display='none';
    if(!visible())return;
    report();
    // Only authenticated proxy references can recover later in the session.
    if(record.source.startsWith('/api/'))retry(record.retries===0?2000:6000);
  });
  picture.src=initial;return picture;
}

export function retryArtworkImages(root=globalThis.document,{limit=30,resetBudget=false}={}){
  let queued=0;
  for(const picture of root?.querySelectorAll?.('img.image-failed')||[]){
    const record=records.get(picture);
    if(!record?.failed||!record.retryable()||record.getScope()!==record.scope)continue;
    // The owner may renew this budget once when cloud sync reconnects. Normal
    // render/focus retries retain their exhausted three-request limit.
    if(resetBudget){clearTimeout(record.timer);record.timer=null;record.retries=0;record.reported=false;}
    if(record.retries<3&&record.retry(0)){if(++queued>=limit)break;}
  }
  return queued;
}
