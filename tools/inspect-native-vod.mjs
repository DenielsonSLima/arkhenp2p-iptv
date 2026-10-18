#!/usr/bin/env node
// Read-only metadata diagnostic for the verified WPLAYP2P 11.9.0d APK.
// Exactly one selected auth server, one tag list, one category page, and
// optionally one title detail. No streams, remote logout, or persisted secrets.
import { readWplayCredentials, safeCode } from './wplay-tool-input.mjs';
import { WplayProviderClient, WPLAY_AUTH_URLS, wplayServiceURL } from '../lib/wplay/conexao/provedor-nativo.mjs';
import { requestUpstream, readBody, validUpstreamURL } from '../lib/upstream.mjs';

const MAX_BYTES=8*1024*1024, TOTAL_MS=45000, IDLE_MS=10000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fieldNames=value=>object(value)?Object.keys(value).filter(key=>/^[a-z_][a-z\d_]{0,63}$/i.test(key)).sort():[];
const emit=value=>console.log(JSON.stringify(value));

function responseShape(buffer) {
  if(!buffer.length)return 'empty';
  if(buffer[0]===0x1f&&buffer[1]===0x8b)return 'gzip-bytes';
  const start=buffer.toString('utf8',0,Math.min(buffer.length,128)).trimStart().charAt(0);
  return ({'[':'json-array','{':'json-object','<':'html-or-xml','"':'json-string'})[start]||'other';
}

function schema(items) {
  const fields={},sourceFields={},sourceSchemes={http:0,https:0,tvbus:0,bts:0,other:0,missing:0};
  let entriesWithSources=0,entriesWithEpisodeSources=0;
  const countFields=(target,entry)=>{for(const key of fieldNames(entry))target[key]=(target[key]||0)+1;};
  for(const item of items){
    if(!object(item))continue;countFields(fields,item);
    const sources=Array.isArray(item.sources)?item.sources:[];
    if(sources.length)entriesWithSources++;
    if(sources.some(source=>/[ST](\d+)-?E(\d+)/.test(String(source?.subTitle??''))))entriesWithEpisodeSources++;
    for(const source of sources){
      countFields(sourceFields,source);
      const protocol=typeof source?.address==='string'?/^([a-z][a-z\d+.-]*):/i.exec(source.address)?.[1].toLowerCase():null;
      sourceSchemes[!protocol?'missing':Object.hasOwn(sourceSchemes,protocol)?protocol:'other']++;
    }
  }
  return {count:items.length,fields,sourceFields,sourceSchemes,entriesWithSources,entriesWithEpisodeSources};
}

function transportError(error,signal) {
  if(signal.aborted)return 'TOTAL_DEADLINE';
  if(error?.message==='Resposta do servidor excedeu o tamanho permitido.')return 'BODY_TOO_LARGE';
  if(error?.message==='Tempo de conexão excedido.')return 'IDLE_TIMEOUT';
  return safeCode(error);
}

async function inspect(phase,url,client,signal) {
  const started=Date.now();let response,bytes;
  try {
    response=await requestUpstream(url,{headers:{'User-Agent':client.userAgent},timeout:IDLE_MS,signal,followRedirects:false});
    const mime=/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+/i.exec(String(response.headers['content-type']||''))?.[0].toLowerCase()||null;
    const encoding=String(response.headers['content-encoding']||'identity').trim().toLowerCase();
    const length=String(response.headers['content-length']||'');
    const metadata={phase,status:response.status,contentType:mime,encoding:['identity','gzip','deflate','br'].includes(encoding)?encoding:'other',contentLength:/^\d{1,12}$/.test(length)?Number(length):null};
    if(response.status!==200){emit({...metadata,elapsedMs:Date.now()-started,code:'HTTP_NON_200'});return null;}
    bytes=await readBody(response,MAX_BYTES);
    let payload;try{payload=JSON.parse(bytes.toString());}catch{emit({...metadata,elapsedMs:Date.now()-started,decodedBytes:bytes.length,shape:responseShape(bytes),code:'JSON_INVALID'});return null;}
    emit({...metadata,elapsedMs:Date.now()-started,decodedBytes:bytes.length,shape:responseShape(bytes),schema:Array.isArray(payload)?schema(payload):{fields:fieldNames(payload)}});
    return payload;
  } catch(error){emit({phase,elapsedMs:Date.now()-started,status:response?.status||null,code:transportError(error,signal)});return null;}
  finally {response?.body.destroy();bytes?.fill(0);}
}

async function main() {
  const primary=process.argv.includes('--primary'),backup=process.argv.includes('--backup');
  if(primary===backup)throw Object.assign(new Error(),{code:'SELECT_ONE_AUTH_SERVER'});
  const auth=await readWplayCredentials();
  const client=new WplayProviderClient({...auth,authURLs:[WPLAY_AUTH_URLS[backup?1:0]]});
  auth.username='';auth.password='';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TOTAL_MS);timer.unref?.();
  try {
    // authenticate() uses the verified APK form and cannot fall back here.
    client.authInfo=await client.authenticate({signal:controller.signal});
    emit({phase:'auth',code:'OK',provider:'wplay',hasTagURL:!!client.authInfo?.service?.vod_tag_url,hasDetailURL:!!client.authInfo?.service?.vod_search_url});
    const groups=await inspect('tags',client.serviceURL('vod_tag_url'),client,controller.signal);
    if(!Array.isArray(groups)){emit({phase:'category-page',code:'NO_VALID_TAG_LIST'});return;}
    let selected;
    for(const group of groups){
      if(!object(group)||!Array.isArray(group.items))continue;
      for(const tag of group.items){
        if(!object(tag)||typeof tag.url!=='string'||!/^https?:\/\//i.test(tag.url))continue;
        try{validUpstreamURL(tag.url);selected=tag;break;}catch{/* No inferred or private destination. */}
      }
      if(selected)break;
    }
    if(!selected){emit({phase:'category-page',code:'NO_OBSERVED_CATEGORY_URL'});return;}
    // ae.t2.o0 chooses the returned tag URL and td.m.d appends the token.
    // Recovered ae.t2.r0 then appends query page=1 using ae.t2.Y.
    const token=client.authInfo?.service?.token;
    const category=wplayServiceURL(selected.url,token);
    const page=await inspect('category-page',category+(category.includes('?')?'&':'?')+'page=1',client,controller.signal);
    if(!process.argv.includes('--detail'))return;
    const title=Array.isArray(page)?page.find(item=>object(item)&&/^\d{1,12}$/.test(String(item.chid??''))):null;
    const base=client.authInfo?.service?.vod_search_url;
    if(!title||typeof base!=='string'||!base){emit({phase:'title-detail',code:'NO_OBSERVED_DETAIL_SOURCE'});return;}
    // sd.a1.onClick: raw SEARCH base + '/@' + chid, then td.m.d(token).
    const detail=await inspect('title-detail',wplayServiceURL(base+'/@'+String(title.chid),token),client,controller.signal);
    if(object(detail))emit({phase:'title-source-schema',schema:schema([detail])});
  } finally {
    clearTimeout(timer);controller.abort();client.session=null;client.authInfo=null;
    client.config.username='';client.config.password='';
  }
}

if(process.argv.includes('--help'))console.log('Uso: node tools/inspect-native-vod.mjs --primary|--backup [--detail]\nEntrada: uma linha JSON via stdin com username e password.\nSaída: status HTTP, headers de formato, bytes, campos/contagens/protocolos; nunca dados, URLs ou tokens.\nLimites: 45s total, 10s inatividade e 8MiB decodificados por resposta. Nenhum vídeo ou logout remoto.');
else main().catch(error=>{emit({phase:'failed',code:safeCode(error),status:error.status||null});process.exitCode=1;});
