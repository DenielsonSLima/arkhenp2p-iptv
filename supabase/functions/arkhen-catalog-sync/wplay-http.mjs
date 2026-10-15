// Fetch-only WPLAY metadata adapter. This module runs in Deno and Node without
// Node APIs, DOM parsing, provider passwords or any playback/native engine.
import {mediaDuration} from '../../../lib/media-duration.mjs';
import {publicProviderURL,assertPublicProviderDestination} from '../_shared/provider-sources.mjs';

const encoder=new TextEncoder(),HASH=/^[a-f0-9]{64}$/i;
const authQuery=/^(?:t|token|access_token|refresh_token|auth|authorization|password|passwd|username|user|key|api_key|apikey|secret|signature|sig|expires|expiry|session|jwt)$/i;
const list=value=>Array.isArray(value)?value:[],object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const numericID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;
const positiveID=value=>numericID(value)&&Number(value)>0?String(Number(value)):null;
const failure=(code,status=502)=>Object.assign(new Error('Não foi possível coletar os metadados WPLAY.'),{code,status});
export function decodeWplayText(value){
  return String(value??'').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#(\d+)|#x([a-f\d]+));/gi,(match,decimal,hex)=>{
    if(decimal||hex){const code=parseInt(decimal||hex,hex?16:10);return code<=0x10ffff?String.fromCodePoint(code):'';}
    return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '})[match.toLowerCase()]||match;
  }).replace(/<[^>]*>/g,'').trim();
}
const display=value=>decodeWplayText(object(value)?value.init??value.i18n?.en??'':value);
const normalized=value=>display(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const kindHint=value=>/\b(?:series?|seriados?|novelas?|doramas?|reality)\b/.test(normalized(value))?'series':/\b(?:filmes?|movies?|cinema)\b/.test(normalized(value))?'movies':null;
const adult=value=>/(?:^|[^a-z0-9])(?:adult(?:o|a|os|as|s)?|xxx|porn(?:o|os|ografia|ographic)?|erotic(?:o|a|os|as)?|hentai|18)(?=$|[^a-z0-9])|\+\s*18|18\s*\+/.test(normalized(value).replace(/\badult\s+swim\b/g,''));
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
const opaqueID=async value=>String(BigInt('0x'+(await digest(value)).slice(0,16))%1000000000000n);

export function publicWplayURL(value){
  try{const url=new URL(value);url.hash='';return publicProviderURL(url.href).href;}catch{throw failure('WPLAY_SERVICE_URL_INVALID');}
}
export function wplayTokenURL(value,token){return !token||value.includes('?t=')||value.includes('&t=')?value:value+(value.indexOf('?')>0?'&t=':'?t=')+String(token);}
export async function sharedImageReference(value,{providerKey,scopeHash}={}){
  if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||''))throw failure('WPLAY_IMAGE_SCOPE_INVALID');
  const url=new URL(publicWplayURL(value));url.username='';url.password='';url.hash='';
  for(const key of [...url.searchParams.keys()])if(authQuery.test(key))url.searchParams.delete(key);
  url.searchParams.sort();return '/api/shared-image/'+await digest(JSON.stringify([providerKey,scopeHash,url.href]));
}

// Same explicit-zone calendar contract as lib/wplay-epg.mjs.
export function wplayTimestamp(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(value);if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),millisecond=Number((match[7]||'').padEnd(3,'0').slice(0,3));
  if(year<1000||month<1||month>12||day<1||day>31||hour>23||minute>59||second>59)return null;
  const wall=Date.UTC(year,month-1,day,hour,minute,second,millisecond),calendar=new Date(wall),zoneHours=Number(match[10]||0),zoneMinutes=Number(match[11]||0);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||zoneHours>23||zoneMinutes>59)return null;
  return wall-(zoneHours*60+zoneMinutes)*60000*(match[9]==='-'?-1:1);
}
function gameStart(value){
  if(typeof value==='number'||typeof value==='string'&&/^\d{10,13}(?:\.\d+)?$/.test(value)){
    const number=Number(value),time=number<1e12?number*1000:number;return number>0&&Number.isFinite(time)&&Number.isFinite(new Date(time).getTime())?new Date(time).toISOString():null;
  }
  const time=wplayTimestamp(value);if(time!==null)return new Date(time).toISOString();
  // The authenticated WPLAY comparison across UTC/-03:00 established that this
  // bare field is UTC; the request offset selects its day window only.
  const parts=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value||'');if(!parts)return null;
  const [year,month,day,hour,minute,second]=parts.slice(1).map(value=>Number(value||0));if(year<1000||hour>23)return null;
  const wall=new Date(Date.UTC(year,month-1,day,hour,minute,second));return wall.getUTCFullYear()===year&&wall.getUTCMonth()===month-1&&wall.getUTCDate()===day?wall.toISOString():null;
}
export function cloudGamesOptions({date,timeZone='UTC',lang='pt'}={},now=Date.now()){
  try{if(typeof timeZone!=='string'||timeZone.length>80)throw 0;timeZone=new Intl.DateTimeFormat('en-US',{timeZone}).resolvedOptions().timeZone;}catch{throw failure('WPLAY_GAMES_REQUEST_INVALID',400);}
  if(date===undefined||date===null||date===''){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),part=type=>parts.find(value=>value.type===type)?.value;date=`${part('year')}-${part('month')}-${part('day')}`;}
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number(date.slice(0,4))<1000||!Number.isFinite(Date.parse(date+'T00:00:00.000Z'))||new Date(date+'T00:00:00.000Z').toISOString().slice(0,10)!==date||typeof lang!=='string'||!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(lang))throw failure('WPLAY_GAMES_REQUEST_INVALID',400);
  return {date,timeZone,lang};
}
export function cloudGamesOffset({date,timeZone}){
  const noon=Date.parse(date+'T12:00:00.000Z'),formatter=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'}),offsetAt=time=>{
    const zone=formatter.formatToParts(time).find(part=>part.type==='timeZoneName')?.value;if(zone==='GMT')return {text:'+00:00',minutes:0};
    const match=/^GMT([+-])(\d{2}):(\d{2})$/.exec(zone||'');if(!match)throw failure('WPLAY_GAMES_REQUEST_INVALID',400);
    return {text:match[1]+match[2]+':'+match[3],minutes:(Number(match[2])*60+Number(match[3]))*(match[1]==='-'?-1:1)};
  };const first=offsetAt(noon);return offsetAt(noon-first.minutes*60000).text;
}

export function createWplayHttpSource({source,fetch:request=globalThis.fetch,mapImage=async()=>'',now=Date.now,timeoutMs=10000,resolveDns=globalThis.Deno?.resolveDns}={}){
  if(source?.provider!=='wplay'||!object(source.service)||typeof source.userAgent!=='string'||!source.userAgent||source.userAgent.length>1000||/[\r\n\0]/.test(source.userAgent))throw failure('WPLAY_SOURCE_INVALID',400);
  const service=source.service,userAgent=source.userAgent,cache=new Map(),images=new Map(),categoryRestrictions=new Map();let tagsPromise,liveRaw;
  const text=(value,max=1000)=>{let result=display(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'');if(typeof service.token==='string'&&service.token.length>=6)result=result.split(service.token).join('');return result.slice(0,max);};
  const memo=(key,read)=>{if(!cache.has(key)){const pending=Promise.resolve().then(read).catch(error=>{cache.delete(key);throw error;});cache.set(key,pending);}return cache.get(key);};
  const json=async(value,{maxBytes=64*1024*1024}={})=>{
    const url=publicWplayURL(value),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response;
    try{
      // Reject private DNS answers before transport. Redirects are forbidden;
      // fetch still performs its own DNS lookup, so this is not DNS pinning.
      try{await assertPublicProviderDestination(url,{resolveDns});}catch{throw failure('WPLAY_SERVICE_URL_INVALID');}
      if(controller.signal.aborted)throw failure('WPLAY_UPSTREAM_TIMEOUT');
      response=await request(url,{headers:{'User-Agent':userAgent,Accept:'application/json'},redirect:'error',signal:controller.signal});
      if(response.status!==200)throw failure('WPLAY_UPSTREAM_HTTP',[401,403].includes(response.status)?401:502);
      const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw failure('WPLAY_RESPONSE_TOO_LARGE');
      const reader=response.body?.getReader();let bytes;
      if(reader){const chunks=[];let count=0;try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maxBytes){await reader.cancel();throw failure('WPLAY_RESPONSE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}}
      else{bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>maxBytes)throw failure('WPLAY_RESPONSE_TOO_LARGE');}
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure('WPLAY_INVALID_RESPONSE');}
    }catch(error){throw error?.code?.startsWith('WPLAY_')?error:failure(controller.signal.aborted?'WPLAY_UPSTREAM_TIMEOUT':'WPLAY_UPSTREAM_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  };
  const endpoint=field=>{if(typeof service[field]!=='string'||!service[field])throw failure('WPLAY_CATALOG_UNAVAILABLE',404);return publicWplayURL(wplayTokenURL(service[field],service.token));};
  const image=async(value,context)=>{
    if(typeof value!=='string'||!value||value.length>8192)return '';
    let url;try{url=publicWplayURL(value);}catch{return '';}
    const key=JSON.stringify([context.kind==='sports-logo'?'sports':'catalog',url]);
    if(!images.has(key))images.set(key,Promise.resolve().then(()=>mapImage(url,{...context,userAgent})).then(ref=>typeof ref==='string'&&(/^\/api\/(?:shared|sports)-image\/[a-f0-9]{64}$/.test(ref)||/^\/assets\/[A-Za-z0-9_./-]+$/.test(ref)&&!ref.includes('..'))?ref:'').catch(()=>{images.delete(key);throw failure('WPLAY_IMAGE_MAPPING_FAILED');}));
    return images.get(key);
  };
  const isSeries=raw=>Number(raw?.seasonCount)>0||list(raw?.sources).some(source=>/[ST](\d+)-?E(\d+)/.test(String(source?.subTitle??'')));
  async function normalizeItems(rawItems,kind,provided=[]){
    const categories=new Map(provided.map(category=>[category.id,{id:category.id,name:category.name,...(category.isAdult?{isAdult:true}:{})}])),items=[],seen=new Set();
    for(const raw of rawItems){
      if(!object(raw))continue;const id=numericID(raw.chid)||numericID(raw.id),name=text(raw.name);if(!id||!name||seen.has(id))continue;seen.add(id);
      const tags=list(raw.tags).filter(tag=>object(tag)&&numericID(tag._id??tag.id));for(const tag of tags){const id=numericID(tag._id??tag.id),name=text(tag.name)||'Outros';categories.set(id,{id,name,...(categories.get(id)?.isAdult||categoryRestrictions.get(id)||tag.restrictedAccess===true||adult(name)?{isAdult:true}:{})});}
      const ids=[...new Set([...provided.map(category=>category.id),...tags.map(tag=>numericID(tag._id??tag.id))])],categoryId=ids[0]||'0';if(!categories.has(categoryId))categories.set(categoryId,{id:categoryId,name:'Outros'});
      const poster=raw.logo?.image?.big||raw.logo?.image?.small||raw.image_logo,backdrop=raw.image_backdrop||raw.logo?.image?.full;
      const item={id,name,kind,categoryId,categoryIds:ids.length?ids:[categoryId],poster:await image(poster,{kind,itemId:id,field:'poster'}),backdrop:await image(backdrop,{kind,itemId:id,field:'backdrop'}),year:text(raw.year,20),rating:Number.isFinite(Number(raw.rating))?Math.max(0,Math.min(10,Number(raw.rating))):0,added:text(raw.updatedAt,80),plot:text(raw.description,20000),genre:tags.map(tag=>text(tag.name,300)).filter(Boolean).join(', ').slice(0,10000),container:'mp4'};
      const imdbId=raw.imdbId??raw.imdb_id,tmdbId=raw.tmdbId??raw.tmdb_id;
      if(typeof imdbId==='string'&&/^tt\d{6,10}$/.test(imdbId))item.imdbId=imdbId;
      if((typeof tmdbId==='number'||typeof tmdbId==='string'&&/^\d+$/.test(tmdbId))&&Number.isSafeInteger(Number(tmdbId))&&Number(tmdbId)>0)item.tmdbId=Number(tmdbId);
      const duration=mediaDuration(raw,...list(raw.sources));if(duration.durationSeconds>0&&duration.durationSeconds<=86400)Object.assign(item,duration);
      if(raw.adult===true||raw.isAdult===true||raw.is_adult===true||raw.restrictedAccess===true||ids.some(id=>categories.get(id)?.isAdult))item.isAdult=true;
      items.push(item);
    }
    return {categories:[...categories.values()],items};
  }
  async function registerCategories(type){
    if(type&&!['live','movies','series'].includes(type))throw failure('WPLAY_CATALOG_TYPE_INVALID',400);
    if(type==='live')return (await catalog('live')).categories;
    if(service.enabledVoD===false)return [];
    if(!service.vod_tag_url)return (await catalog(type||'movies')).categories;
    if(!tagsPromise)tagsPromise=(async()=>{
      const payload=await json(endpoint('vod_tag_url'),{maxBytes:4*1024*1024});if(!Array.isArray(payload))throw failure('WPLAY_INVALID_CATALOG');const categories=new Map();
      for(const group of payload)for(const tag of list(group?.items)){
        const name=text(tag?.name),original=tag?._id??tag?.id;if(!name||original==null||typeof tag?.url!=='string')continue;let url;try{url=publicWplayURL(tag.url);}catch{continue;}
        const id=numericID(original)||await opaqueID(`category:${group.group_id??display(group.group_name)}:${String(original)}`),hint=kindHint(name)||kindHint(group.group_name);
        const isAdult=group.restrictedAccess===true||tag.restrictedAccess===true||adult(name)||adult(group.group_name);
        if(isAdult)categoryRestrictions.set(id,true);
        if(!categories.has(id))categories.set(id,{id,name,url,hint,isAdult});
        else if(isAdult)categories.get(id).isAdult=true;
      }
      if(!categories.size)throw failure('WPLAY_EMPTY_CATALOG',503);return [...categories.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
    })().catch(error=>{tagsPromise=null;throw error;});
    const rows=await tagsPromise;return rows.filter(category=>!type||!category.hint||category.hint===type).map(({id,name,isAdult})=>({id,name,...(isAdult?{isAdult:true}:{})}));
  }
  async function catalog(type){
    if(!['live','movies','series'].includes(type))throw failure('WPLAY_CATALOG_TYPE_INVALID',400);
    if(type==='live')return memo('live',async()=>{
      if(service.enabledLive===false)return {categories:[],items:[],catalogComplete:true};
      const payload=await json(endpoint('ch_url'));if(!Array.isArray(payload))throw failure('WPLAY_INVALID_CATALOG');liveRaw=payload;
      return {...await normalizeItems(payload,'live'),catalogComplete:true};
    });
    if(service.enabledVoD===false)return {categories:[],items:[],catalogComplete:true};
    if(service.vod_tag_url){const categories=await registerCategories(type);return {categories,items:[],pagination:{mode:'category',byCategory:Object.fromEntries(categories.map(({id})=>[id,{nextPage:1,hasMore:true,loaded:false}]))}};}
    const payload=await memo('legacy-vod',async()=>{const rows=await json(endpoint('vod_url'));if(!Array.isArray(rows))throw failure('WPLAY_INVALID_CATALOG');return rows;});
    return {...await normalizeItems(payload.filter(raw=>isSeries(raw)===(type==='series')),type==='series'?'series':'movie'),catalogComplete:true};
  }
  async function catalogPage(type,categoryId,page){
    if(!['movies','series'].includes(type))throw failure('WPLAY_CATALOG_TYPE_INVALID',400);
    if(!Number.isSafeInteger(page)||page<1||page>10000)throw failure('WPLAY_PAGE_INVALID',400);
    if(!service.vod_tag_url)return catalog(type);
    const categories=await registerCategories(type),category=categories.find(value=>value.id===String(categoryId));if(!category)throw failure('WPLAY_CATEGORY_INVALID',400);
    const registered=(await tagsPromise).find(value=>value.id===category.id),base=wplayTokenURL(registered.url,service.token),payload=await json(base+(base.includes('?')?'&':'?')+'page='+page,{maxBytes:8*1024*1024});
    if(!Array.isArray(payload))throw failure('WPLAY_INVALID_CATALOG');
    const rawItems=payload.filter(raw=>(isSeries(raw)?'series':registered.hint==='series'?'series':'movies')===type),normalized=await normalizeItems(rawItems,type==='series'?'series':'movie',[category]);
    return {...normalized,hasMore:payload.length>0,nextPage:page+1,pagination:{mode:'category',byCategory:{[category.id]:{nextPage:page+1,hasMore:payload.length>0,loaded:true}}}};
  }
  async function catalogStep(type,{categoryIndex=0,page=1}={}){
    if(type==='live'||!service.vod_tag_url||service.enabledVoD===false){const data=await catalog(type);return {categories:data.categories,items:data.items,next:null,complete:true};}
    const categories=await registerCategories(type);if(!Number.isSafeInteger(categoryIndex)||categoryIndex<0||categoryIndex>categories.length)throw failure('WPLAY_CATEGORY_CURSOR_INVALID',400);
    if(categoryIndex===categories.length)return {categories,items:[],next:null,complete:true};
    const data=await catalogPage(type,categories[categoryIndex].id,page),next=data.hasMore?{categoryIndex,page:data.nextPage}:categoryIndex+1<categories.length?{categoryIndex:categoryIndex+1,page:1}:null;
    return {categories:[...new Map([...categories,...data.categories].map(category=>[category.id,category])).values()],items:data.items,next,complete:next===null};
  }
  async function epg(){
    if(!service.epg_url||service.enabledLive===false)return {channels:[]};
    return memo('epg',async()=>{
      const payload=await json(endpoint('epg_url'),{maxBytes:16*1024*1024});if(!Array.isArray(payload))throw failure('WPLAY_INVALID_EPG');const guides=new Map();
      for(const channel of payload){const id=positiveID(channel?.id);if(!id||!Array.isArray(channel.epg))continue;if(!guides.has(id))guides.set(id,new Map());
        for(const program of channel.epg){if(!object(program)||typeof program.name!=='string')continue;const title=text(program.name),start=wplayTimestamp(program.time),end=wplayTimestamp(program.endTime);if(!title||start===null||end===null||end<=start)continue;guides.get(id).set(JSON.stringify([title,start,end]),{title,description:'',start:new Date(start).toISOString(),end:new Date(end).toISOString()});}
      }
      const rows=service.ch_url?(await catalog('live')).items:null,aliases=new Map((liveRaw||[]).map(raw=>[numericID(raw?.chid)||numericID(raw?.id),positiveID(raw?.epgSameAs)||positiveID(raw?.chid)||positiveID(raw?.id)]));
      return {channels:(rows?rows.map(item=>({id:item.id,guideId:aliases.get(item.id)||positiveID(item.id)})):[...guides.keys()].map(id=>({id,guideId:id}))).map(({id,guideId})=>({channel_id:id,payload:{list:[...(guides.get(guideId)?.values()||[])].sort((a,b)=>a.start.localeCompare(b.start))}}))};
    });
  }
  async function games(value){
    const options=cloudGamesOptions(value,now());if(typeof service.football_url!=='string'||!service.football_url.trim())return {available:false,date:options.date,timeZone:options.timeZone,games:[],message:'O serviço não disponibilizou a agenda de jogos para esta conta.'};
    return memo('games:'+JSON.stringify(options),async()=>{
      const url=new URL(publicWplayURL(service.football_url));url.pathname=url.pathname.replace(/\/$/,'')+'/games';const query=new URLSearchParams({date:options.date,timezone:cloudGamesOffset(options),lang:options.lang});
      const payload=await json(wplayTokenURL(url.href+(url.search?'&':'?')+query,service.token),{maxBytes:4*1024*1024});
      if(!object(payload))throw failure('WPLAY_INVALID_GAMES');if(payload.code!==undefined&&payload.code!==0&&payload.code!==200)throw failure('WPLAY_GAMES_REJECTED');if(!Array.isArray(payload.data))throw failure('WPLAY_INVALID_GAMES');
      const games=[],seen=new Set(),identity=value=>/^[\w-]{1,120}$/.test(String(value??''))?String(value):null;
      const team=async raw=>{if(!object(raw))return null;const id=identity(raw.id)||'',name=text(raw.name,300);return id||name?{id,name,logo:await image(raw.logo,{kind:'sports-logo',itemId:id,field:'logo'})}:null;};
      for(const raw of payload.data){const id=object(raw)&&identity(raw.id);if(!id||seen.has(id))continue;seen.add(id);const teams=await Promise.all(list(raw.teams).map(team)),channels=[],ids=new Set();
        for(const channel of list(raw.channels)){const id=positiveID(channel?.chid??channel?.id);if(!id||ids.has(id))continue;ids.add(id);channels.push({id,name:text(channel.name,300)});}
        games.push({id,title:text(raw.name,300),league:await team(raw.league),start:gameStart(raw.date),status:text(raw.status,80),homeTeam:teams[0]||null,awayTeam:teams[1]||null,score:text(raw.score,80),channels});
      }
      return {available:true,date:options.date,timeZone:options.timeZone,games};
    });
  }
  return {registerCategories,catalogPage,catalog,catalogStep,epg,games};
}
