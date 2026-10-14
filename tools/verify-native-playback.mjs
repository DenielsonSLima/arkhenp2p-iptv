import {readFile} from 'node:fs/promises';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';
import {NativeBridgeClient} from '../lib/native-bridge.mjs';
import {readBody,requestUpstream} from '../lib/upstream.mjs';
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
const emit=v=>console.log(JSON.stringify(v));
const client=new WplayProviderClient({...await readWplayCredentials(),authURLs:[WPLAY_AUTH_URLS[1]]});
let bridge;
try{
 await client.connect();emit({phase:'auth',connected:true});
 if(process.argv.includes('--vod')){
  for(const type of ['movies','series']){
   const catalog=await client.catalog(type);emit({phase:type,categories:catalog.categories.length,loaded:catalog.items.length});
   const item=catalog.items[0];const detail=await client.details(item.kind,item.id);
   emit({phase:'detail',kind:item.kind,title:detail.name,seasons:detail.seasons.length,episodes:detail.seasons.reduce((n,s)=>n+s.episodes.length,0)});
   const id=item.kind==='series'?detail.seasons[0]?.episodes[0]?.id:item.id;
   const source=await client.playbackURL(item.kind,id);
   const response=await requestUpstream(source,{headers:{...client.upstreamHeaders(source),Range:'bytes=0-32767'},timeout:20000,signal:AbortSignal.timeout(25000)});
   let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>=32768){response.body.destroy();break;}}
   emit({phase:'media',kind:item.kind,status:response.status,contentType:response.headers['content-type'],bytes});
  }
 }else{
  const catalog=await client.catalog('live');
  const item=catalog.items.find(i=>/^tv brasil(?:\s|$)/i.test(i.name))||catalog.items.find(i=>/^sbt(?:\s|$)/i.test(i.name));
  if(!item)throw Object.assign(new Error(),{code:'NO_TEST_CHANNEL'});
  const source=client.sources(client.rawItems.get('live:'+item.id)).find(s=>s.address?.startsWith('tvbus://'));
  bridge=new NativeBridgeClient({key:(await readFile('.local/native-bridge-key','utf8')).trim()});
  emit({phase:'bridge-before',...await bridge.status()});
  await bridge.configure({authUrl:client.authInfo.service.auth_url_sdk,username:client.config.username.includes('@')?client.config.username:client.config.username+'@wareztv.io',password:client.config.password});
  emit({phase:'engine-auth',...await bridge.status()});
  const started=Date.now();const url=await bridge.start(source.address,{timeout:40000});
  emit({phase:'prepared',elapsedMs:Date.now()-started,...await bridge.status()});
  const playlist=await bridge.fetchMedia(url);const text=(await readBody(playlist,1024*1024)).toString();
  emit({phase:'playlist',status:playlist.status,valid:text.startsWith('#EXTM3U')});
  const line=text.split(/\r?\n/).find(s=>s&&!s.startsWith('#'));
  if(line){const segment=await bridge.fetchMedia(new URL(line,url));let bytes=0;for await(const chunk of segment.body){bytes+=chunk.length;if(bytes>=32768){segment.body.destroy();break;}}emit({phase:'segment',status:segment.status,bytes});}
 }
}catch(error){emit({phase:'failed',code:safeCode(error)});if(bridge)emit({phase:'bridge-status',...await bridge.status().catch(()=>({state:'unavailable'}))});process.exitCode=1;}
finally{await bridge?.stop().catch(()=>{});client.authInfo=null;client.config.username='';client.config.password='';}
