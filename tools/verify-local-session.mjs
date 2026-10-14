import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
const base='http://127.0.0.1:4173',emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();let cookie='';
async function request(route,options={}){return fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(45000)});}
try{
 const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
 credentials.password='';credentials.username='';cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
 const account=await login.json();emit({phase:'local-login',status:login.status,connected:account.connected,provider:account.account?.provider});
 if(!account.connected)throw Object.assign(new Error(),{code:account.code||'LOGIN_FAILED'});
 for(const type of ['live','movies','series']){
  const res=await request('/api/catalog?type='+type),data=await res.json();
  emit({phase:'catalog',type,status:res.status,categories:data.categories?.length,loaded:data.items?.length});
  const item=data.items?.[0];if(!item)continue;
  if(item.poster){const image=await request(item.poster);emit({phase:'cover',type,status:image.status,contentType:image.headers.get('content-type')});await image.arrayBuffer();}
  if(type==='live')continue;
  const resDetail=await request(`/api/details?type=${item.kind}&id=${item.id}&duration=1`),detail=await resDetail.json();
  emit({phase:'detail',type,status:resDetail.status,title:detail.name,year:detail.year,rating:detail.rating,durationSeconds:detail.durationSeconds,seasons:detail.seasons?.length,episodes:detail.seasons?.reduce((n,s)=>n+s.episodes.length,0)});
  const id=type==='series'?detail.seasons?.[0]?.episodes?.[0]?.id:item.id;
  const video=await request(`/api/play/${item.kind}/${id}.mp4`,{headers:{Range:'bytes=0-32767'}});
  const buf=Buffer.from(await video.arrayBuffer());emit({phase:'video',type,status:video.status,mime:video.headers.get('content-type'),bytes:buf.length,mp4:buf.subarray(4,8).toString()==='ftyp'});
  await request('/api/stop',{method:'POST',body:'{}'});
 }
}catch(error){emit({phase:'failed',code:safeCode(error)});process.exitCode=1;}
finally{if(cookie)await request('/api/logout',{method:'POST',body:'{}'}).catch(()=>{});cookie='';}
