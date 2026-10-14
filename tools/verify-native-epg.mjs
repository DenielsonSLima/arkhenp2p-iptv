import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';

// This verifier requests only account metadata, the live catalogue and EPG.
// It never starts a stream or exports provider addresses/tokens/replay URLs.
const local=process.argv.includes('--local'),emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();
const client=local?null:new WplayProviderClient({...credentials,authURLs:[WPLAY_AUTH_URLS[1]]});
const base='http://127.0.0.1:4173';let cookie='';
async function request(route,options={}){
  const response=await fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error('LOCAL_REQUEST_FAILED'),{code:data.code||'HTTP_'+response.status,status:response.status});
  if(route==='/api/login')cookie=response.headers.get('set-cookie')?.split(';')[0]||'';
  return data;
}
try{
  let started=performance.now();
  const session=local?await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})}):await client.connect();
  credentials.username='';credentials.password='';
  emit({phase:'login',mode:local?'local-api':'provider',connected:session.connected,ms:Math.round(performance.now()-started)});
  started=performance.now();
  const catalog=local?await request('/api/catalog?type=live'):await client.catalog('live');
  emit({phase:'catalog',channels:catalog.items.length,ms:Math.round(performance.now()-started)});
  const targets=[
    catalog.items.find(item=>item.id==='46'&&/sbt/i.test(item.name))||catalog.items.find(item=>/^sbt(?:\s|$)/i.test(item.name)),
    catalog.items.find(item=>/^sportv(?:\s|$)/i.test(item.name)),
    catalog.items.find(item=>/globo.*sergipe|sergipe.*globo/i.test(item.name))||catalog.items.find(item=>/^globo(?:\s|$)/i.test(item.name))
  ].filter(Boolean);
  const results=await Promise.all(targets.map(async item=>{
    const before=performance.now(),guide=local?await request('/api/epg?id='+item.id):await client.epg(item.id),now=Date.now();
    const current=guide.list.find(row=>Date.parse(row.start)<=now&&Date.parse(row.end)>now);
    const next=guide.list.find(row=>Date.parse(row.start)>now);
    const raw=client?.rawItems.get('live:'+item.id);
    return {phase:'guide',channel:item.name,id:item.id,...(raw?{epgID:String(Number(raw.epgSameAs)>0?raw.epgSameAs:raw.chid)}:{}),
      programs:guide.list.length,ms:Math.round(performance.now()-before),current:current||null,next:next||null};
  }));
  results.forEach(emit);
  if(client){
    const index=await client.cache.get('epg:wplay:global')?.promise;
    emit({phase:'index',guides:index?.size||0,programs:index?[...index.values()].reduce((n,rows)=>n+rows.length,0):0});
  }
  if(targets.length!==3||results.some(row=>!row.programs))process.exitCode=1;
}catch(error){emit({phase:'failed',code:safeCode(error),status:error.status});process.exitCode=1;}
finally{
  credentials.username='';credentials.password='';
  if(cookie)await request('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
  cookie='';
  if(client){client.cache.clear();client.authInfo=null;client.session=null;client.config.username='';client.config.password='';}
}
