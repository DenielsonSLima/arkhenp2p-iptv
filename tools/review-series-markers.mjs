// Explicit metadata review, never included in the server or npm test. Only
// public title/segment responses and safe IPTV display metadata are persisted.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {prioritizedReviewSeries,reviewCatalogTitle,reviewedSeriesIdentity} from '../lib/series-marker-review.mjs';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
import {inspectSegments,canonicalSeries} from '../supabase/functions/series-markers-sync/metadata.mjs';

const apply=process.argv.includes('--apply'),root='https://wnicimkmzswksaqdtgdv.supabase.co',sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const source=JSON.parse(await readFile('.local/iptv-series-candidates.json','utf8'));
let library=[];try{library=JSON.parse(await readFile('.local/iptv-library-series-priority.json','utf8'));}catch{}
const selected=prioritizedReviewSeries(source.items,library,50),cacheFile='.local/marker-top50-public-cache.json';
let cache={};try{cache=JSON.parse(await readFile(cacheFile,'utf8'));}catch{}
let bulkEntities={},previousRequests={};try{bulkEntities=JSON.parse(await readFile('.local/marker-top50-wikidata-entities.json','utf8')).entities||{};}catch{}
try{const previous=JSON.parse(await readFile('reports/top50-series-marker-review.json','utf8'));previousRequests=previous.statistics?.totalRequests||previous.statistics?.requests||{};}catch{}
const last={},cooldowns={},stats={requests:{imdb:0,wikidata:0,skipdb:0,introdb:0},cached:0},results=[];
const report={reviewedAt:new Date().toISOString(),catalogCapturedAt:source.capturedAt,catalogComplete:false,selectionPolicy:'Até 50 séries reais: itens já presentes no aplicativo primeiro; depois notas do provedor e diversidade nas categorias capturadas. Não é um ranking oficial.',candidatePool:source.items.length,maximumIntroDBRequests:150,editionPolicy:'Horários sem duração original permanecem referência manual; nenhum runtime ou deslocamento é inferido.',rows:results};
const csv=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
async function save(){
 stats.totalRequests=Object.fromEntries(Object.entries(stats.requests).map(([provider,count])=>[provider,count+(previousRequests[provider]||0)]));
 await mkdir('reports',{recursive:true});
 await writeFile('reports/top50-series-marker-review.json',JSON.stringify({...report,statistics:stats},null,2));
 const columns=['position','iptvId','iptvTitle','year','providerRating','category','identityStatus','identityReason','imdbId','matchedTitle','episodesChecked','skipDBEpisodesWithIntro','introDBEpisodesWithIntro','introDBEmpty','introDBFailed'];
 await writeFile('reports/top50-series-marker-review.csv',columns.join(',')+'\n'+results.map(row=>columns.map(key=>csv(row[key])).join(',')).join('\n')+'\n');
 await writeFile(cacheFile,JSON.stringify(cache));
}
const minimal=(source,payload)=>{
 if(source==='imdb')return {d:(payload.d||[]).map(({id,l,y,qid})=>({id,l,y,qid}))};
 if(source==='wikidata'&&payload.search)return {search:payload.search.map(({id,label,aliases})=>({id,label,aliases}))};
 if(source==='wikidata'&&payload.entities)return {entities:Object.fromEntries(Object.entries(payload.entities).map(([id,row])=>[id,{id,labels:row.labels,aliases:row.aliases,claims:{P345:row.claims?.P345||[]}}]))};
 if(source==='skipdb'&&payload.local)return {local:payload.local.map(({name,year,media_type,imdb_id,imdbId,tmdb_id,tmdbId})=>({name,year,media_type,imdb_id,imdbId,tmdb_id,tmdbId}))};
 if(source==='skipdb')return {imdb_id:payload.imdb_id,name:payload.name,year:payload.year,media_type:payload.media_type,seasons:payload.seasons,totals:payload.totals,episodes:(payload.episodes||[]).map(({season,episode,runtimeMs})=>({season,episode,runtimeMs}))};
 if(source==='introdb')return Object.fromEntries(['imdb_id','season','episode','intro','recap','outro','preview','post_credits'].filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]));
 return {};
};
async function publicJSON(provider,url){
 if(cache[url]){stats.cached++;return cache[url];}
 if(cooldowns[provider]>Date.now())return {status:'failed',error:'PROVIDER_COOLDOWN',url,retryAt:new Date(cooldowns[provider]).toISOString()};
 const interval=provider==='skipdb'?2100:provider==='introdb'?1100:provider==='wikidata'?550:350;
 await sleep(Math.max(0,(last[provider]||0)+interval-Date.now()));last[provider]=Date.now();stats.requests[provider]++;
 try{
  const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'ARKHEN-Metadata-Review/1.0'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(response.status===429||response.status===503){const retry=response.headers.get('retry-after'),delay=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(60000,(Date.parse(retry)||0)-Date.now());cooldowns[provider]=Date.now()+Math.min(3600000,Math.max(60000,delay));return {status:'failed',error:'PROVIDER_RATE_LIMITED',url,retryAt:new Date(cooldowns[provider]).toISOString()};}
  const result={status:response.status===404?'empty':response.ok?'ok':'failed',httpStatus:response.status,url,retrievedAt:new Date().toISOString()};
  if(response.ok){const text=await response.text();if(Buffer.byteLength(text)>4*1024*1024)throw 0;result.payload=minimal(provider,JSON.parse(text));}
  else if(response.status!==404)result.error='PROVIDER_HTTP_'+response.status;
  if(result.status!=='failed')cache[url]=result;return result;
 }catch{return {status:'failed',error:'PROVIDER_NETWORK_OR_SCHEMA_FAILED',url};}
}
let dump=null;try{const cached=JSON.parse(await readFile('.local/skipdb/dump.json','utf8'));dump=cached.dump||cached;}catch{}
const skipEpisodes=new Map();for(const row of dump?.segments||[]){if(row.status!=='approved'||row.media_type!=='series'||!row.episode)continue;const key=[row.imdb_id,row.season,row.episode].join(':');if(!skipEpisodes.has(key))skipEpisodes.set(key,[]);skipEpisodes.get(key).push(row);}
await save();
for(const [index,item]of selected.entries()){
 const title=reviewCatalogTitle(item),row={position:index+1,iptvId:String(item.id),iptvTitle:item.name,year:title.year,providerRating:Number(item.rating)||null,category:item.sourceCategory?.name||'Itens do aplicativo',priorityReason:item.priorityReason,identityStatus:'pending',episodes:[]};results.push(row);
 try{
  if(title.yearConflict){row.identityStatus='unresolved';row.identityReason='CATALOG_YEAR_CONFLICT';continue;}
  const [imdb,skipdb,wiki]=await Promise.all([
   publicJSON('imdb','https://v3.sg.media-imdb.com/suggestion/x/'+encodeURIComponent(title.name)+'.json'),
   publicJSON('skipdb','https://skipdb.tv/api/titles/search?q='+encodeURIComponent(title.name)),
   publicJSON('wikidata','https://www.wikidata.org/w/api.php?'+new URLSearchParams({action:'wbsearchentities',search:title.name,language:'pt',uselang:'pt',format:'json',limit:'8'}))
  ]);
  let entities={...bulkEntities};const ids=(wiki.payload?.search||[]).map(row=>row.id).filter(id=>/^Q\d+$/.test(id));
  if(ids.length){const response=await publicJSON('wikidata','https://www.wikidata.org/w/api.php?'+new URLSearchParams({action:'wbgetentities',ids:ids.join('|'),props:'labels|aliases|claims',languages:'pt|pt-br|en',format:'json'}));entities={...entities,...(response.payload?.entities||{})};}
  const identity=reviewedSeriesIdentity(item,{imdbPayload:imdb.payload,skipdbPayload:skipdb.payload,wikidataEntities:entities});row.identityStatus=identity.status;row.identityReason=identity.reason||null;
  row.identityLookups=[imdb,skipdb,wiki].map(({url,status,httpStatus,error})=>({url,status,httpStatus,error}));
  if(!identity.identity)continue;
  const verified=identity.identity;Object.assign(row,{imdbId:verified.imdb_id,tmdbId:verified.tmdb_id,seriesSlug:verified.series_slug,matchedTitle:verified.title,identityMethod:verified.method,identitySources:verified.sources});
  const inventory=await publicJSON('skipdb','https://skipdb.tv/api/titles/'+verified.imdb_id);
  const validInventory=inventory.payload?.imdb_id===verified.imdb_id&&inventory.payload?.media_type==='series';
  row.skipDBInventory={status:validInventory?'verified':inventory.status,url:inventory.url,seasons:validInventory?inventory.payload.seasons:[],totals:validInventory?inventory.payload.totals:null};
  const first=(validInventory?inventory.payload.episodes:[]).filter(ep=>ep.season>=1&&ep.episode>=1).sort((a,b)=>a.season-b.season||a.episode-b.episode).slice(0,3);
  const requested=first.length?first:[{season:1,episode:1},{season:1,episode:2},{season:1,episode:3}];
  for(const ep of requested){
   const raw=skipEpisodes.get([verified.imdb_id,ep.season,ep.episode].join(':'))||[],url='https://api.introdb.app/segments?'+new URLSearchParams({imdb_id:verified.imdb_id,season:String(ep.season),episode:String(ep.episode)});
   const introdb=await publicJSON('introdb',url),episode={season:ep.season,episode:ep.episode,inventoryConfirmed:Boolean(first.length),skipDB:{status:raw.length?'approved-source-data':'no-approved-data',sourceUrl:'https://skipdb.tv/api/dump',sourceGeneratedAt:dump?.generated_at,editionDurationsSeconds:[...new Set(raw.map(segment=>segment.duration_ms).filter(value=>Number.isFinite(value)&&value>0).map(value=>value/1000))],hasIntro:raw.some(segment=>segment.segment_type==='intro'&&segment.end_ms>segment.start_ms)},introDB:{status:introdb.status,url,retrievedAt:introdb.retrievedAt,httpStatus:introdb.httpStatus,error:introdb.error}};
   if(introdb.status==='ok')try{const inspected=inspectSegments('introdb',introdb.payload,{imdb_id:verified.imdb_id,season:ep.season,episode:ep.episode});episode.introDB.status=inspected.status;episode.introDB.evidence=inspected.evidence;}catch{episode.introDB.status='failed';episode.introDB.error='SOURCE_IDENTITY_OR_SEGMENT_INVALID';}
   row.episodes.push(episode);
  }
  row.episodesChecked=row.episodes.length;row.skipDBEpisodesWithIntro=row.episodes.filter(ep=>ep.skipDB.hasIntro).length;row.introDBEpisodesWithIntro=row.episodes.filter(ep=>ep.introDB.evidence?.intro).length;row.introDBEmpty=row.episodes.filter(ep=>ep.introDB.status==='empty').length;row.introDBFailed=row.episodes.filter(ep=>ep.introDB.status==='failed').length;
 }catch{row.identityStatus='failed';row.identityReason='REVIEW_LOOKUP_FAILED';}
 finally{await save();console.log(JSON.stringify({position:row.position,title:row.iptvTitle,status:row.identityStatus,imdbId:row.imdbId||null,episodes:row.episodes.length,introDBIntros:row.introDBEpisodesWithIntro||0}));}
}
if(apply){
 let raw;try{raw=execFileSync(resolve('.local/bin/supabase.exe'),['projects','api-keys','--project-ref','wnicimkmzswksaqdtgdv','--reveal','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:4*1024*1024});}catch{throw new Error('REVIEW_ADMIN_KEY_LOOKUP_FAILED');}
 const parsed=JSON.parse(raw),keys=Array.isArray(parsed)?parsed:parsed.keys||parsed.data||[],entry=keys.find(row=>row.name==='service_role'||row.role==='service_role'),key=entry?.api_key??entry?.key;
 if(typeof key!=='string'||!key.startsWith('eyJ'))throw new Error('REVIEW_ADMIN_KEY_REQUIRED');raw=null;
 const store=new MarkerStore({url:root,key}),ids=results.map(row=>row.iptvId),oldIdentities=await store.call('/rest/v1/series_marker_identities?'+new URLSearchParams({select:'*',provider_key:'eq.'+source.providerKey,scope_hash:'eq.'+source.scopeHash,media_id:'in.('+ids.join(',')+')'}));
 const resolvedIDs=[...new Set(results.filter(row=>row.imdbId).map(row=>row.imdbId))],oldTitles=resolvedIDs.length?await store.call('/rest/v1/series_marker_titles?'+new URLSearchParams({select:'imdb_id,tmdb_id',imdb_id:'in.('+resolvedIDs.join(',')+')'})):[];
 let writtenIdentities=0,writtenEpisodes=0;
 for(const row of results){
  const prior=oldIdentities.find(old=>old.media_id===row.iptvId);if(prior?.status==='resolved'&&row.imdbId&&prior.imdb_id!==row.imdbId){row.databaseStatus='IDENTITY_CONFLICT_PRESERVED';continue;}
  const time=new Date().toISOString(),item=selected.find(item=>String(item.id)===row.iptvId),resolved=row.identityStatus==='resolved';
  if(resolved){row.tmdbId??=prior?.imdb_id===row.imdbId?prior.tmdb_id:null;row.tmdbId??=oldTitles.find(title=>title.imdb_id===row.imdbId)?.tmdb_id;await store.save('series_marker_titles',[{...canonicalSeries(row.imdbId,row.matchedTitle,row.tmdbId),year:row.year}],'imdb_id');}
  if(prior?.status==='resolved'&&!resolved){row.databaseStatus='EXISTING_RESOLVED_IDENTITY_PRESERVED';continue;}
  await store.save('series_marker_identities',[{provider_key:source.providerKey,scope_hash:source.scopeHash,media_id:row.iptvId,catalog_name:row.iptvTitle,catalog_metadata:{...(prior?.catalog_metadata||{}),year:row.year,rating:item.rating||0,kind:'series'},status:row.identityStatus==='failed'?'failed':row.identityStatus==='ambiguous'?'ambiguous':resolved?'resolved':'unresolved',...(resolved?{imdb_id:row.imdbId,tmdb_id:row.tmdbId,series_slug:row.seriesSlug}:{}),evidence:{method:row.identityMethod||'manual-top50-unresolved',sources:(row.identitySources||row.identityLookups?.map(value=>value.url)||[]).map(url=>({url,retrievedAt:time})),review:'IPTV top50 metadata review',catalogCapturedAt:source.capturedAt},error_code:row.identityReason,next_check_at:new Date(Date.now()+(resolved?30:7)*86400000).toISOString(),updated_at:time}],'provider_key,scope_hash,media_id');writtenIdentities++;
  for(const episode of row.episodes){
   const filters=new URLSearchParams({select:'*',imdb_id:'eq.'+row.imdbId,season:'eq.'+episode.season,episode:'eq.'+episode.episode,limit:'1'}),old=(await store.call('/rest/v1/series_marker_coverage?'+filters))?.[0],failed=episode.introDB.status==='failed';
   const introEvidence=episode.introDB.evidence||{},existingReady=old?.status==='ready',hasIntro=Boolean(introEvidence.intro);
   const evidence={...(old?.evidence||{}),...(episode.introDB.status!=='failed'?{introdb:introEvidence}:{}),manualReview:{sourceUrl:episode.introDB.url,retrievedAt:episode.introDB.retrievedAt||time,identitySources:row.identitySources,editionVerified:false}};
   const hasEvidence=['skipdb','introdb'].some(source=>Object.keys(evidence[source]||{}).length),status=existingReady?'ready':hasEvidence?'unverified':failed?'failed':'empty';
   await store.save('series_marker_coverage',[{imdb_id:row.imdbId,season:episode.season,episode:episode.episode,series_slug:row.seriesSlug,tmdb_id:row.tmdbId,status,source:existingReady?old.source:hasIntro?'introdb':old?.source||null,skipdb_status:old?.skipdb_status||(episode.skipDB.hasIntro?'approved-source-data':null),introdb_status:episode.introDB.status,evidence,error_code:existingReady?old.error_code:failed?episode.introDB.error:Object.keys(introEvidence).length?'SOURCE_EDITION_DURATION_UNAVAILABLE':null,next_check_at:existingReady?old.next_check_at:new Date(Date.now()+(failed?900000:7*86400000)).toISOString(),updated_at:time}],'imdb_id,season,episode');writtenEpisodes++;
  }
  row.databaseStatus='review-saved';
 }
 await store.bumpVersion();report.database={identitiesWritten:writtenIdentities,episodesWritten:writtenEpisodes,privateUserWrites:0};
}
report.summary={selected:results.length,resolved:results.filter(row=>row.identityStatus==='resolved').length,unresolved:results.filter(row=>row.identityStatus==='unresolved').length,ambiguous:results.filter(row=>row.identityStatus==='ambiguous').length,failed:results.filter(row=>row.identityStatus==='failed').length,episodesChecked:results.reduce((sum,row)=>sum+row.episodes.length,0),skipDBEpisodesWithIntro:results.reduce((sum,row)=>sum+(row.skipDBEpisodesWithIntro||0),0),introDBEpisodesWithIntro:results.reduce((sum,row)=>sum+(row.introDBEpisodesWithIntro||0),0)};
await save();console.log(JSON.stringify({state:'review-complete',...report.summary,database:report.database||null,requests:stats.requests,cumulativeRequests:stats.totalRequests,files:['reports/top50-series-marker-review.json','reports/top50-series-marker-review.csv']}));
