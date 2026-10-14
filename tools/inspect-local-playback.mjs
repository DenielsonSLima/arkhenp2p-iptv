import {readWplayCredentials,safeCode,sanitizeWplayMessage} from './wplay-tool-input.mjs';

const titleID=process.argv[2],episodeID=process.argv[3];
if(![titleID,episodeID].every(id=>/^\d{1,12}$/.test(id||'')))throw new Error('INVALID_TARGET');
const base='http://127.0.0.1:4173',emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials(),secrets=[credentials.username,credentials.password];
let cookie='';
const sanitize=value=>sanitizeWplayMessage(value,secrets);
async function request(route,options={}) {
  return fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(40000)});
}
async function prefix(response) {
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(size<65536){const {done,value}=await reader.read();if(done)break;const part=value.subarray(0,65536-size);chunks.push(Buffer.from(part));size+=part.length;}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
try {
  let start=performance.now();
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
  cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
  credentials.username='';credentials.password='';
  const account=await login.json();emit({phase:'login',status:login.status,connected:account.connected,ms:Math.round(performance.now()-start)});
  if(!login.ok||!account.connected)throw Object.assign(new Error(sanitize(account.error)),{code:account.code||'LOGIN_FAILED'});
  start=performance.now();
  const response=await request(`/api/details?type=series&id=${titleID}`),detail=await response.json();
  const registered=!!detail.seasons?.some(s=>s.episodes?.some(e=>e.id===episodeID));
  emit({phase:'details',status:response.status,episodeRegistered:registered,ms:Math.round(performance.now()-start),
    ...(!response.ok?{code:detail.code,error:sanitize(detail.error)}:{})});
  if(!response.ok||!registered)throw Object.assign(new Error(),{code:'EPISODE_NOT_REGISTERED'});
  for(const range of ['bytes=0-65535','bytes=0-']) {
    start=performance.now();
    try {
      const response=await request(`/api/play/series/${episodeID}.mp4`,{headers:{Range:range}});
      const headerMs=Math.round(performance.now()-start),bytes=await prefix(response);
      let error,code;
      if(!response.ok){try{const data=JSON.parse(bytes.toString());error=sanitize(data.error);code=data.code;}catch{code='NON_JSON';}}
      emit({phase:'video',range,status:response.status,headerMs,ms:Math.round(performance.now()-start),
        ...(response.ok?{mime:response.headers.get('content-type'),contentRange:response.headers.get('content-range'),
          bytes:bytes.length,mp4:bytes.subarray(4,8).toString()==='ftyp'}:{code,error})});
    }catch(error){emit({phase:'video',range,ms:Math.round(performance.now()-start),code:safeCode(error),error:sanitize(error.message)});}
    await request('/api/stop',{method:'POST',body:'{}'}).then(r=>r.body?.cancel());
  }
}catch(error){emit({phase:'failed',code:safeCode(error),error:sanitize(error.message)});process.exitCode=1;}
finally{
  credentials.username='';credentials.password='';secrets.fill('');
  if(cookie)await request('/api/logout',{method:'POST',body:'{}'}).then(r=>r.body?.cancel()).catch(()=>{});
  cookie='';
}
