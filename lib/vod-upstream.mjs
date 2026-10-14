import {setTimeout as delay} from 'node:timers/promises';
import {requestUpstream} from './upstream.mjs';

const transientStatus=new Set([502,503,504]);
const transientCode=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH']);
const transientError=error=>transientCode.has(error?.code)
  ||Array.isArray(error?.errors)&&error.errors.length>0&&error.errors.every(item=>transientCode.has(item?.code));

// One retry, before any response is handed to the browser. The registered
// source and Range stay identical; partial transfers are never replayed here.
export async function requestVODUpstream(value,options={},request=requestUpstream) {
  const retryableMethod=['GET','HEAD'].includes(options.method||'GET');
  for(let attempt=0;;attempt++) {
    options.signal?.throwIfAborted();
    try {
      const response=await request(value,options);
      if(attempt||!retryableMethod||!transientStatus.has(response.status)||options.signal?.aborted)return response;
      response.body.destroy();
    }catch(error){
      if(attempt||!retryableMethod||!transientError(error)||options.signal?.aborted)throw error;
    }
    await delay(150,undefined,{signal:options.signal});
  }
}
