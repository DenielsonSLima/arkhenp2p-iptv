import {markerRequest,markerRequestKey,sourceSegments} from '../../../web/serie/marcadores/referencia.js';

const aborted=()=>new DOMException('Consulta de marcações cancelada.','AbortError');
/** One selected episode only. No dump, season inventory, discovery or timer. */
export class EpisodeMarkersOnDemand{
  constructor({fetch:request=globalThis.fetch,now=Date.now,timeoutMs=3000}={}){
    Object.assign(this,{request,now,timeoutMs});this.cache=new Map();this.pending=new Map();this.cooldowns=new Map();this.rates=new Map();
  }
  async source(source,input,signal){
    const now=this.now(),minimum=source==='SkipDB'?550:1100;
    if((this.cooldowns.get(source)||0)>now||(this.rates.get(source)||0)>now)return null;
    this.rates.set(source,now+minimum);
    const query=new URLSearchParams({imdb_id:input.imdbId,season:String(input.season),episode:String(input.episode)});
    if(source==='SkipDB'){query.set('duration',String(input.duration));query.set('adjust','none');}
    const origin=source==='SkipDB'?'https://api.skipdb.tv/api/segments':'https://api.introdb.app/segments';
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]);
    try{
      const response=await this.request(origin+'?'+query,{headers:{Accept:'application/json'},signal:bounded,redirect:'error'});
      if(response.status===429||response.status===503){
        const retry=response.headers.get('retry-after'),seconds=/^\d+$/.test(retry||'')?Number(retry):Math.max(0,Date.parse(retry)-now)/1000;
        this.cooldowns.set(source,now+Math.max(60000,Math.min(3600000,(seconds||60)*1000)));
      }
      if(!response.ok){await response.body?.cancel();return response.status===404?{}:null;}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return null;}chunks.push(value);}}
      finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return sourceSegments(source,JSON.parse(new TextDecoder().decode(bytes)),input);
    }catch{if(signal.aborted)throw aborted();return null;}
  }
  async collect(input,signal){
    const first=await this.source('SkipDB',input,signal);if(signal.aborted)throw aborted();
    // The second API only fills missing types; it never intersects timestamps.
    const second=first&&Object.hasOwn(first,'intro')&&Object.hasOwn(first,'outro')?null:await this.source('IntroDB',input,signal);
    if(signal.aborted)throw aborted();
    const segments=Object.fromEntries(Object.entries({...second,...first}).filter(([,part])=>part!==null));
    // Compare only responses already fetched to fill missing types. A small
    // difference is tolerated; do not add requests merely to compare providers.
    for(const [type,part]of Object.entries(segments))if(first?.[type]&&second?.[type]){
      const delta=Math.max(Math.abs(first[type].start-second[type].start),Math.abs(first[type].end-second[type].end));
      if(delta>5)part.divergenceSeconds=Math.round(delta*1000)/1000;
    }
    const status=Object.keys(segments).length?'reference':first!==null||second!==null?'empty':'unavailable';
    return {schemaVersion:1,...input,status,segments,ttlSeconds:status==='reference'?86400:status==='empty'?3600:60};
  }
  lookup(value,{signal}={}){
    const input=markerRequest(value);if(!input)throw new TypeError('MARKER_REQUEST_INVALID');
    if(signal?.aborted)return Promise.reject(aborted());
    const key=markerRequestKey(input),cached=this.cache.get(key);
    if(cached&&cached.expires>this.now())return Promise.resolve(structuredClone(cached.value));
    let job=this.pending.get(key);
    if(!job||job.controller.signal.aborted){
      job={controller:new AbortController(),readers:0};this.pending.set(key,job);
      job.promise=this.collect(input,job.controller.signal).then(result=>{
        if(job.controller.signal.aborted)throw aborted();
        this.cache.delete(key);this.cache.set(key,{value:result,expires:this.now()+result.ttlSeconds*1000});
        while(this.cache.size>512)this.cache.delete(this.cache.keys().next().value);return result;
      }).finally(()=>{job.settled=true;if(this.pending.get(key)===job)this.pending.delete(key);});
    }
    job.readers++;
    return new Promise((resolve,reject)=>{
      let finished=false;
      const end=(callback,value)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',cancel);job.readers--;if(!job.readers&&!job.settled)job.controller.abort();callback(value);};
      const cancel=()=>end(reject,aborted());signal?.addEventListener('abort',cancel,{once:true});
      job.promise.then(value=>end(resolve,structuredClone(value)),error=>end(reject,error));if(signal?.aborted)cancel();
    });
  }
}
