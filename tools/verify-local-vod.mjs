import {readWplayCredentials,safeCode,sanitizeWplayMessage} from './wplay-tool-input.mjs';

const base='http://127.0.0.1:4173';
const emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();
let cookie='',failed=false;

async function request(route,options={}) {
  const started=performance.now();
  const response=await fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(45000)});
  return {response,ms:Math.round(performance.now()-started)};
}
async function json(route,options={}) {
  const {response,ms}=await request(route,options);
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(sanitizeWplayMessage(data.error)),{code:data.code||'LOCAL_HTTP_'+response.status});
  return {data,response,ms};
}
async function readPrefix(response,limit) {
  const reader=response.body.getReader(),chunks=[];let count=0;
  try {
    while(count<limit){
      const {done,value}=await reader.read();if(done)break;
      const part=value.subarray(0,limit-count);chunks.push(Buffer.from(part));count+=part.length;
    }
  }finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}

try {
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
  credentials.username='';credentials.password='';
  cookie=login.response.headers.get('set-cookie')?.split(';')[0]||'';
  const account=await login.response.json();
  emit({phase:'login',status:login.response.status,connected:account.connected,provider:account.account?.provider,ms:login.ms});
  if(!login.response.ok||!account.connected)throw Object.assign(new Error(),{code:account.code||'LOGIN_FAILED'});

  for(const type of process.argv.includes('--series-only')?['series']:['movies','series']) {
    const {data:catalog,ms}=await json('/api/catalog?type='+type);
    emit({phase:'catalog',type,categories:catalog.categories?.length,items:catalog.items?.length,pagination:catalog.pagination?.mode,ms});
    if(!catalog.items?.length)throw Object.assign(new Error(),{code:'EMPTY_'+type.toUpperCase()});
    let item=catalog.items[0],sampledDetail;
    if(type==='series'&&process.argv.includes('--follow-up')) {
      // Only a few detail documents; stop when season grouping is represented.
      for(const candidate of catalog.items.slice(1,7)) {
        const {data,ms}=await json(`/api/details?type=series&id=${candidate.id}`);
        emit({phase:'season-sample',title:data.name,seasons:data.seasons?.length||0,
          episodes:data.seasons?.reduce((n,s)=>n+s.episodes.length,0)||0,ms});
        item=candidate;sampledDetail=data;
        if(data.seasons?.length>1)break;
      }
    }
    emit({phase:'selection',type,title:item.name});
    const loadedCategory=Object.entries(catalog.pagination?.byCategory||{}).find(([,state])=>state.loaded&&state.hasMore);
    if(loadedCategory) {
      const [id,state]=loadedCategory;
      const {data:page,ms:pageMs}=await json(`/api/catalog?type=${type}&category=${id}&page=${state.nextPage}`);
      const next=page.pagination?.byCategory?.[id];
      emit({phase:'page',type,requested:state.nextPage,nextPage:next?.nextPage,hasMore:next?.hasMore,items:page.items?.length,ms:pageMs});
      if(!next||next.nextPage<=state.nextPage)throw Object.assign(new Error(),{code:'PAGINATION_NOT_ADVANCED'});
    }
    if(item.poster?.startsWith('/api/image?')) {
      const {response,ms:coverMs}=await request(item.poster);
      const bytes=await readPrefix(response,32768);
      let error;
      if(!response.ok){try{error=sanitizeWplayMessage(JSON.parse(bytes.toString()).error);}catch{}}
      emit({phase:'cover',type,status:response.status,mime:response.headers.get('content-type'),sampleBytes:bytes.length,ms:coverMs,...(error?{error}:{})});
      if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))failed=true;
    }
    if(type==='movies'&&process.argv.includes('--follow-up'))continue;
    const {data:detail,ms:detailMs}=sampledDetail?{data:sampledDetail,ms:0}:await json(`/api/details?type=${item.kind}&id=${item.id}&duration=1`);
    const episodeCount=detail.seasons?.reduce((count,season)=>count+season.episodes.length,0)||0;
    emit({phase:'details',type,title:detail.name,year:detail.year,rating:detail.rating,durationSeconds:detail.durationSeconds,
      seasons:detail.seasons?.length||0,episodes:episodeCount,hasSynopsis:!!detail.plot,ms:detailMs});
    const episode=detail.seasons?.[0]?.episodes?.[0];
    if(type==='series'&&!episode)throw Object.assign(new Error(),{code:'EPISODES_MISSING'});
    const mediaID=episode?.id||item.id;
    const {response,ms:videoMs}=await request(`/api/play/${item.kind}/${mediaID}.mp4`,{headers:{Range:'bytes=0-32767'}});
    const bytes=await readPrefix(response,32768);
    const mp4=bytes.subarray(4,8).toString()==='ftyp';
    const matroska=bytes.subarray(0,4).toString('hex')==='1a45dfa3';
    emit({phase:'video',type,status:response.status,mime:response.headers.get('content-type'),sampleBytes:bytes.length,mp4,matroska,
      range:!!response.headers.get('content-range'),ms:videoMs,
      ...(episode?{season:episode.season,episode:episode.number}:{}),
    });
    if(!response.ok||(!mp4&&!matroska))failed=true;
    await json('/api/stop',{method:'POST',body:'{}'});
  }
}catch(error){failed=true;emit({phase:'failed',code:safeCode(error),message:sanitizeWplayMessage(error.message)});}
finally {
  credentials.username='';credentials.password='';
  if(cookie)await request('/api/logout',{method:'POST',body:'{}'}).then(({response})=>response.body?.cancel()).catch(()=>{});
  cookie='';
}
emit({phase:'complete',passed:!failed});
if(failed)process.exitCode=1;
