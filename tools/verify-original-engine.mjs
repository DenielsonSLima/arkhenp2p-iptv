// Exercise only catalogue-issued sources in the user's isolated original APK.
// Credentials, native source URIs and provider responses never enter diagnostics.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
const emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();
const provider=new WplayProviderClient({...credentials,authURLs:[WPLAY_AUTH_URLS[1]]});
let child,reader,owned,rpc;
try {
 await provider.connect();
 const catalogue=await provider.catalog('live');
 const chosen=[/^tv brasil(?:\s|$)/i,/^sbt(?:\s|$)/i].map(pattern=>catalogue.items.find(item=>pattern.test(item.name)));
 if(chosen.some(item=>!item))throw Object.assign(new Error(),{code:'TEST_CHANNEL_UNAVAILABLE'});
 child=spawn('native-bridge/debug-runtime/python/bin/python',['tools/original-engine/client.py','--endpoint','127.0.0.1:27043'],{stdio:['pipe','pipe','ignore']});
 reader=createInterface({input:child.stdout});
 const lines=reader[Symbol.asyncIterator]();
 const receive=async()=>{
  const {value,done}=await lines.next();if(done)throw Object.assign(new Error(),{code:'ENGINE_CLIENT_CLOSED'});
  const response=JSON.parse(value);
  if(!response.ok)throw Object.assign(new Error(),{code:response.error});
  return response.result;
 };
 rpc=async request=>{child.stdin.write(JSON.stringify(request)+'\n');return receive();};
 const attached=await receive();emit({phase:'attached',state:attached.state});
 const channelIds=new Set();
 for(const [index,item]of chosen.entries()){
  const source=provider.sources(provider.rawItems.get('live:'+item.id)).find(s=>s.address?.startsWith('tvbus://'));
  if(!source)throw Object.assign(new Error(),{code:'TEST_SOURCE_UNAVAILABLE'});
  owned='verify-channel-'+index;
  const started=Date.now();
  const result=await rpc({op:'start',requestId:owned,uri:source.address,timeoutMs:45000});
  if(!Number.isSafeInteger(result.channelId)||channelIds.has(result.channelId))throw Object.assign(new Error(),{code:'CHANNEL_ID_NOT_CHANGED'});
  channelIds.add(result.channelId);
  emit({phase:'prepared',channel:item.name,elapsedMs:Date.now()-started,distinctChannel:true,diagnostics:result.diagnostics});
  const url=new URL(result.hls);url.port='8904';
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  const manifest=await response.text();
  emit({phase:'playlist',channel:item.name,status:response.status,valid:manifest.startsWith('#EXTM3U')});
  let text=manifest,base=url;
  for(let depth=0;depth<3;depth++){
   const relative=text.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
   if(!relative)throw Object.assign(new Error(),{code:'NO_MEDIA_SEGMENT'});
   const media=new URL(relative,base);
   if(media.origin!==url.origin||!media.pathname.startsWith(url.pathname.replace(/[^/]+$/,'')))throw Object.assign(new Error(),{code:'INVALID_LOCAL_MEDIA'});
   const segment=await fetch(media,{redirect:'error',signal:AbortSignal.timeout(15000)});
   const reader=segment.body.getReader();let count=0;const parts=[];
   try{while(count<65536){const{value,done}=await reader.read();if(done)break;parts.push(value);count+=value.length;}}finally{await reader.cancel();}
   const bytes=Buffer.concat(parts);
   if(bytes.toString('utf8',0,7)==='#EXTM3U'){text=bytes.toString();base=media;continue;}
   emit({phase:'segment',channel:item.name,status:segment.status,bytes:bytes.length,mpegts:bytes[0]===0x47&&bytes[188]===0x47});
   break;
  }
 }
}catch(error){
 emit({phase:'failed',code:safeCode(error)});process.exitCode=1;
 if(rpc)try{const status=await rpc({op:'status'});emit({phase:'callback-diagnostics',state:status.state,
   diagnostics:status.diagnostics,callbackCounts:status.callbackCounts,callbackShapes:status.callbackShapes,nativeState:status.nativeState});}catch{}
}
finally{
 if(child&&!child.killed){child.stdin.end(JSON.stringify({op:'detach'})+'\n');setTimeout(()=>child.kill(),3000).unref();}
 provider.authInfo=null;provider.config.username='';provider.config.password='';credentials.username='';credentials.password='';
}
