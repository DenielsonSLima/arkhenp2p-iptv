import {artworkURL,fallbackArtworkURL} from './channel-artwork.js';

const records=new WeakMap();

/** Keep transient proxy failures recoverable without rebuilding whole shelves. */
export function bindArtworkImage(picture,{source,fallback='',getScope=()=>'',onFailure=()=>{}}={}){
  const initial=artworkURL(source),scope=getScope();
  const record={scope,getScope,source:initial,fallback:artworkURL(fallback),fallbackTried:false,retries:0,timer:null,failed:false,reported:false};records.set(picture,record);
  const current=()=>getScope()===scope;
  const load=()=>{
    if(!current())return;
    clearTimeout(record.timer);record.timer=null;record.failed=false;
    picture.classList.remove('image-failed');picture.style.removeProperty('display');picture.parentElement?.classList.add('artwork-ready');
  };
  const retry=delay=>{
    if(record.timer!==null||record.retries>=3||!current())return;
    record.timer=setTimeout(()=>{
      record.timer=null;if(!current()||!picture.isConnected)return;
      record.retries++;picture.classList.remove('image-failed');picture.style.removeProperty('display');
      const separator=record.source.includes('?')?'&':'?';picture.src=`${record.source}${separator}artwork_retry=${record.retries}`;
    },delay);
  };
  record.retry=retry;
  picture.addEventListener('load',load);
  picture.addEventListener('error',()=>{
    if(!current())return;
    const recovery=fallbackArtworkURL(record.source,record.fallback);
    if(!record.fallbackTried&&recovery){record.fallbackTried=true;record.source=recovery;picture.src=recovery;return;}
    record.failed=true;picture.parentElement?.classList.remove('artwork-ready');picture.classList.add('image-failed');picture.style.display='none';
    if(!record.reported){record.reported=true;try{onFailure(record.source);}catch{/* Recovery of another card cannot break this image. */}}
    // Only authenticated proxy references can recover later in the session.
    if(record.source.startsWith('/api/'))retry(record.retries===0?2000:6000);
  });
  picture.src=initial;return picture;
}

export function retryArtworkImages(root=globalThis.document,{limit=30}={}){
  let queued=0;
  for(const picture of root?.querySelectorAll?.('img.image-failed')||[]){
    const record=records.get(picture);
    if(record?.failed&&record.source.startsWith('/api/')&&record.getScope()===record.scope&&record.retries<3){record.retry(0);if(++queued>=limit)break;}
  }
}
