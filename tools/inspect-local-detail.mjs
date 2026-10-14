import {readWplayCredentials,safeCode,sanitizeWplayMessage} from './wplay-tool-input.mjs';

const id=process.argv[2],type=process.argv[3]||'series';
if(!/^\d{1,12}$/.test(id||'')||!['movie','series'].includes(type))throw new Error('INVALID_TARGET');
const base='http://127.0.0.1:4173',emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials(),secrets=[credentials.username,credentials.password];
let cookie='';
const sanitize=value=>sanitizeWplayMessage(value,secrets);
async function request(route,options={}) {
  return fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(45000)});
}
async function readPrefix(response,limit=32768) {
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{while(length<limit){const {done,value}=await reader.read();if(done)break;const part=value.subarray(0,limit-length);chunks.push(Buffer.from(part));length+=part.length;}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
try {
  let started=performance.now();
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
  credentials.username='';credentials.password='';cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
  const session=await login.json();
  emit({phase:'login',status:login.status,connected:session.connected,ms:Math.round(performance.now()-started)});
  if(!login.ok||!session.connected)throw Object.assign(new Error(sanitize(session.error)),{code:session.code||'LOGIN_FAILED'});
  const imagePaths=new Set();
  for(let attempt=1;attempt<=(process.argv.includes('--images-only')?0:2);attempt++) {
    started=performance.now();
    try {
      const response=await request(`/api/details?type=${type}&id=${id}`),data=await response.json();
      emit({phase:'details',attempt,status:response.status,ms:Math.round(performance.now()-started),
        ...(response.ok?{seasons:data.seasons?.length||0,episodes:data.seasons?.reduce((n,s)=>n+(s.episodes?.length||0),0)||0}:
          {code:safeCode({code:data.code||'LOCAL_HTTP_'+response.status}),error:sanitize(data.error)})});
      if(response.ok)for(const value of [data.poster,data.backdrop])if(typeof value==='string'&&value.startsWith('/api/image?ref='))imagePaths.add(value);
    }catch(error){emit({phase:'details',attempt,ms:Math.round(performance.now()-started),code:safeCode(error),error:sanitize(error.message)});}
  }
  if(!imagePaths.size) {
    started=performance.now();
    const response=await request(`/api/catalog?type=${type==='movie'?'movies':'series'}`),data=await response.json();
    emit({phase:'catalog-images',status:response.status,ms:Math.round(performance.now()-started),
      ...(response.ok?{items:data.items?.length||0}:{code:safeCode({code:data.code||'LOCAL_HTTP_'+response.status}),error:sanitize(data.error)})});
    if(response.ok)for(const item of data.items||[]) {
      if(typeof item.poster==='string'&&item.poster.startsWith('/api/image?ref='))imagePaths.add(item.poster);
      if(imagePaths.size===2)break;
    }
  }
  let imageIndex=0;
  for(const path of [...imagePaths].slice(0,2)) {
    imageIndex++;started=performance.now();
    try{
      const response=await request(path),bytes=await readPrefix(response);
      let error,code;
      if(!response.ok){try{const data=JSON.parse(bytes.toString());error=sanitize(data.error);code=safeCode({code:data.code||'LOCAL_HTTP_'+response.status});}catch{code='IMAGE_NON_JSON';}}
      emit({phase:'image',index:imageIndex,status:response.status,ms:Math.round(performance.now()-started),
        ...(response.ok?{bytes:bytes.length,mime:response.headers.get('content-type')}:{code,error})});
    }catch(error){emit({phase:'image',index:imageIndex,ms:Math.round(performance.now()-started),code:safeCode(error),error:sanitize(error.message)});}
  }
}catch(error){emit({phase:'failed',code:safeCode(error),error:sanitize(error.message)});process.exitCode=1;}
finally{
  credentials.username='';credentials.password='';secrets.fill('');
  if(cookie)await request('/api/logout',{method:'POST',body:'{}'}).then(r=>r.body?.cancel()).catch(()=>{});
  cookie='';
}
