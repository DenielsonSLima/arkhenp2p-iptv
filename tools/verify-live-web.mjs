// Real local integration check. Credentials and upstream URLs stay in memory.
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
const base='http://127.0.0.1:4173',emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();let cookie='';
async function request(route,options={}) {
  if(!route.startsWith('/api/'))throw Object.assign(new Error(),{code:'INVALID_TEST_ROUTE'});
  return fetch(base+route,{...options,headers:{Cookie:cookie,...options.headers},signal:AbortSignal.timeout(60000)});
}
try {
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,provider:'wplay'})});
  credentials.username='';credentials.password='';cookie=login.headers.get('set-cookie')?.split(';')[0]||'';
  const account=await login.json();
  emit({phase:'login',status:login.status,connected:account.connected});
  if(!account.connected)throw Object.assign(new Error(),{code:account.code||'LOGIN_FAILED'});
  const catalog=await(await request('/api/catalog?type=live')).json();
  const requested=process.argv.find(value=>/^--channel=\d{1,12}$/.test(value))?.split('=')[1];
  const channels=requested?[catalog.items?.find(item=>String(item.id)===requested)]:[/^tv brasil(?:\s|$)/i,/^sbt(?:\s|$)/i].map(pattern=>catalog.items?.find(item=>pattern.test(item.name)));
  if(channels.some(item=>!item))throw Object.assign(new Error(),{code:'TEST_CHANNEL_UNAVAILABLE'});
  for(const channel of channels) {
    const started=Date.now();
    let route=`/api/play/live/${channel.id}/index.m3u8`;
    for(let depth=0;depth<4;depth++) {
      const response=await request(route);
      if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(),{code:data.code||'MEDIA_HTTP_FAILED'});}
      if(/mpegurl/i.test(response.headers.get('content-type'))) {
        const manifest=await response.text();
        if(!manifest.startsWith('#EXTM3U'))throw Object.assign(new Error(),{code:'INVALID_PLAYLIST'});
        emit({phase:'playlist',channel:channel.name,status:response.status,elapsedMs:Date.now()-started,
          tags:manifest.split(/\r?\n/).filter(line=>/^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|ENDLIST|PLAYLIST-TYPE)|EXTINF)(?::[\d., A-Z-]*)?$/.test(line))});
        route=manifest.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
        if(!route?.startsWith('/api/asset/'))throw Object.assign(new Error(),{code:'UNREWRITTEN_ASSET'});
        continue;
      }
      const reader=response.body.getReader(),parts=[];let size=0;
      try {while(size<65536){const {value,done}=await reader.read();if(done)break;parts.push(value);size+=value.length;}}
      finally {await reader.cancel();}
      const bytes=Buffer.concat(parts),valid=bytes[0]===0x47&&bytes[188]===0x47;
      emit({phase:'segment',channel:channel.name,status:response.status,bytes:bytes.length,mpegts:valid,elapsedMs:Date.now()-started});
      if(!valid)throw Object.assign(new Error(),{code:'INVALID_VIDEO_SEGMENT'});
      break;
    }
    await request('/api/stop',{method:'POST',body:'{}'});
  }
} catch(error) {emit({phase:'failed',code:safeCode(error)});process.exitCode=1;}
finally {if(cookie)await request('/api/logout',{method:'POST',body:'{}'}).catch(()=>{});credentials.username='';credentials.password='';cookie='';}
