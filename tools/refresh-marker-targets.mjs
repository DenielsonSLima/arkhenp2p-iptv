// Explicit, repeatable source-reference audit. No user/session/playback data.
// --apply uses the already authorized CLI session for the fixed project only.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
import {canonicalSeries,explicitIdentity,episodeInventory} from '../supabase/functions/series-markers-sync/metadata.mjs';

const PROJECT='wnicimkmzswksaqdtgdv',ROOT='https://'+PROJECT+'.supabase.co';
export const MARKER_AUDIT_TARGETS=Object.freeze([
  {imdb:'tt0944947',year:2011,maxSeason:8,priority:100,ids:['999725200']},
  {imdb:'tt2306299',year:2013,maxSeason:6,priority:90,ids:['131129','999726546']},
  {imdb:'tt11311302',year:2022,maxSeason:3,priority:80,ids:['999728421','105002']},
  {imdb:'tt0388629',year:1999,maxSeason:23,priority:60,ids:['148757','87812597']},
  {imdb:'tt11737520',year:2023,maxSeason:2,priority:70,ids:['130931']},
  {imdb:'tt7631058',year:2022,maxSeason:2,priority:50,ids:['999730340']}
]);
const fail=code=>Object.assign(new Error(code),{code});
export function targetInventoryPlan(report,now=Date.now()){
  const captured=Date.parse(report?.retrievedAt);
  if(!Number.isFinite(captured)||captured>now+60000||now-captured>86400000)throw fail('AUDIT_INVENTORY_STALE');
  return MARKER_AUDIT_TARGETS.map(target=>{
    const matches=(report.titles||[]).filter(row=>row.url==='https://skipdb.tv/api/titles/'+target.imdb&&row.status===200&&row.payload?.imdb_id===target.imdb&&row.payload?.media_type==='series'&&row.payload?.year===target.year);
    if(matches.length!==1)throw fail('AUDIT_INVENTORY_IDENTITY_INVALID');
    const source=matches[0],episodes=episodeInventory(source.payload,target.imdb);
    if(!episodes.length)throw fail('AUDIT_INVENTORY_EMPTY');
    return {...target,sourceUrl:source.url,title:source.payload.name,capturedAt:report.retrievedAt,episodes,requested:episodes.filter(row=>row.season>=1&&row.season<=target.maxSeason)};
  });
}
export function targetCatalogIdentity(row,target){
  if(row.media_type!=='series'||row.is_adult||!row.is_active||!target.ids.includes(String(row.media_id)))throw fail('AUDIT_CATALOG_IDENTITY_INVALID');
  const identity=explicitIdentity({catalog_name:row.name,catalog_metadata:row.metadata});
  if(identity?.imdb_id!==target.imdb||identity?.year!==target.year)throw fail('AUDIT_CATALOG_IDENTITY_INVALID');
  return identity;
}
function adminKey(){
  let text;
  try{text=execFileSync(resolve('.local/bin/supabase.exe'),['projects','api-keys','--project-ref',PROJECT,'--reveal','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:4*1024*1024});}catch{throw fail('AUDIT_CLI_SESSION_UNAVAILABLE');}
  const parsed=JSON.parse(text),keys=Array.isArray(parsed)?parsed:parsed.keys||parsed.data||[],entry=keys.find(row=>row.name==='service_role'||row.role==='service_role');text=null;
  const key=entry?.api_key??entry?.key;if(typeof key!=='string'||!key.startsWith('eyJ'))throw fail('AUDIT_SERVER_CREDENTIAL_REQUIRED');return key;
}
async function main(){
  const source=JSON.parse(await readFile('reports/marker-source-audit-2026-10-15-inventories.json','utf8')),plan=targetInventoryPlan(source),prepareSQL=process.argv.includes('--prepare-sql'),apply=process.argv.includes('--apply')||prepareSQL;
  const summary={requestedAt:new Date().toISOString(),applied:false,sourceInventoryIsNotIPTVAvailability:true,editionVerified:false,titles:plan.map(row=>({imdbId:row.imdb,title:row.title,year:row.year,nativeIds:row.ids,sourceEpisodes:row.episodes.length,requestedEpisodes:row.requested.length,numbering:'source-native'}))};
  if(!apply){console.log(JSON.stringify(summary));return;}
  const store=new MarkerStore({url:ROOT,key:adminKey()}),ids=plan.flatMap(row=>row.ids);
  const generations=await store.call('/rest/v1/catalog_visible_generations?'+new URLSearchParams({select:'provider_key,scope_hash,generation_id',media_type:'eq.series'}));
  const rows=await store.call('/rest/v1/catalog_media?'+new URLSearchParams({select:'provider_key,scope_hash,media_type,media_id,name,metadata,is_adult,is_active,generation_id,last_seen_snapshot',media_type:'eq.series',media_id:'in.('+ids.join(',')+')',is_active:'eq.true',limit:'100'}));
  const visible=rows.filter(row=>generations.some(g=>g.provider_key===row.provider_key&&g.scope_hash===row.scope_hash&&g.generation_id===row.generation_id));
  const existing=await store.call('/rest/v1/series_marker_identities?'+new URLSearchParams({select:'provider_key,scope_hash,media_id,status,imdb_id',media_id:'in.('+ids.join(',')+')',limit:'100'}));
  const bindings=[];
  for(const target of plan)for(const id of target.ids){
    const matches=visible.filter(row=>String(row.media_id)===id);if(!matches.length)throw fail('AUDIT_CATALOG_ITEM_MISSING');
    for(const row of matches){
      const identity=targetCatalogIdentity(row,target),prior=existing.find(old=>old.provider_key===row.provider_key&&old.scope_hash===row.scope_hash&&old.media_id===row.media_id);
      if(prior?.status==='resolved'&&prior.imdb_id!==identity.imdb_id)throw fail('AUDIT_EXISTING_IDENTITY_CONFLICT');
      bindings.push({provider_key:row.provider_key,scope_hash:row.scope_hash,media_id:row.media_id,catalog_name:row.name,catalog_metadata:row.metadata,source_snapshot:row.last_seen_snapshot,status:'resolved',imdb_id:identity.imdb_id,tmdb_id:identity.tmdb_id,series_slug:identity.series_slug,error_code:null,next_check_at:new Date(Date.now()+30*86400000).toISOString(),updated_at:summary.requestedAt,evidence:{method:'curated-exact-title-year-public-identity',titleYear:target.year,sources:[{url:target.sourceUrl,retrievedAt:target.capturedAt},{url:'https://www.imdb.com/title/'+target.imdb+'/',retrievedAt:target.capturedAt}],editionVerified:false}});
    }
  }
  if(prepareSQL){
    // This path is applied atomically through the authorized Management SQL
    // helper, after the worker with revision fences has been deployed.
    const literal=value=>"'"+JSON.stringify(value).replace(/'/g,"''")+"'::jsonb";
    const titles=plan.map(target=>({...canonicalSeries(target.imdb,target.title),year:target.year,inventory_status:'ready',inventory_error:null,inventory_check_at:new Date(Date.now()+7*86400000).toISOString(),updated_at:summary.requestedAt}));
    const inventory=plan.flatMap(target=>{const canonical=canonicalSeries(target.imdb,target.title);return target.episodes.map(episode=>({...episode,imdb_id:target.imdb,series_slug:canonical.series_slug,tmdb_id:canonical.tmdb_id}));});
    const requested=plan.flatMap(target=>target.requested.map(episode=>({...episode,imdb_id:target.imdb,audit_priority:target.priority})));
    const timestamp="'"+summary.requestedAt+"'::timestamptz";
    const sql=`begin;
set local lock_timeout='5s';set local statement_timeout='55s';
select pg_advisory_xact_lock(hashtextextended('arkhen-marker-target-audit',0));
create temporary table audit_bindings on commit drop as select * from jsonb_populate_recordset(null::public.series_marker_identities,${literal(bindings)});
do $$begin
 if exists(select 1 from audit_bindings b where not exists(select 1 from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id) where m.media_type='series' and m.provider_key=b.provider_key and m.scope_hash=b.scope_hash and m.media_id=b.media_id and m.name=b.catalog_name and m.last_seen_snapshot is not distinct from b.source_snapshot and m.is_active and not m.is_adult)) then raise exception 'AUDIT_CATALOG_CHANGED';end if;
 if exists(select 1 from audit_bindings b join public.series_marker_identities i using(provider_key,scope_hash,media_id) where i.status='resolved' and i.imdb_id<>b.imdb_id) then raise exception 'AUDIT_IDENTITY_CHANGED';end if;
end$$;
insert into public.series_marker_titles(imdb_id,series_slug,title,year,tmdb_id,inventory_status,inventory_error,inventory_check_at,updated_at)
select imdb_id,series_slug,title,year,tmdb_id,inventory_status,inventory_error,inventory_check_at,updated_at from jsonb_populate_recordset(null::public.series_marker_titles,${literal(titles)})
on conflict(imdb_id) do update set series_slug=excluded.series_slug,title=excluded.title,year=excluded.year,tmdb_id=excluded.tmdb_id,inventory_status=excluded.inventory_status,inventory_error=null,inventory_check_at=excluded.inventory_check_at,updated_at=excluded.updated_at;
insert into public.series_marker_identities select * from audit_bindings
on conflict(provider_key,scope_hash,media_id) do update set catalog_name=excluded.catalog_name,catalog_metadata=excluded.catalog_metadata,source_snapshot=excluded.source_snapshot,status=excluded.status,imdb_id=excluded.imdb_id,tmdb_id=excluded.tmdb_id,series_slug=excluded.series_slug,error_code=null,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at,evidence=excluded.evidence;
insert into public.series_marker_coverage(imdb_id,series_slug,tmdb_id,season,episode,runtime_hint_seconds)
select imdb_id,series_slug,tmdb_id,season,episode,runtime_hint_seconds from jsonb_populate_recordset(null::public.series_marker_coverage,${literal(inventory)}) on conflict(imdb_id,season,episode) do nothing;
update public.series_marker_coverage c set runtime_hint_seconds=coalesce(q.runtime_hint_seconds,c.runtime_hint_seconds),audit_priority=q.audit_priority,audit_requested_at=${timestamp},audit_next_check_at=${timestamp},audit_checked_at=null,updated_at=${timestamp}
from jsonb_populate_recordset(null::public.series_marker_coverage,${literal(requested)}) q where c.imdb_id=q.imdb_id and c.season=q.season and c.episode=q.episode;
update public.marker_cache_versions set generation=gen_random_uuid(),updated_at=now() where name='global';
commit;
`;
    await writeFile('.local/marker-target-atomic.sql',sql);
    summary.preparedSQL=true;summary.identitiesPrepared=bindings.length;summary.referencesQueued=0;summary.referencesPrepared=requested.length;
    await writeFile('reports/marker-target-refresh-2026-10-15.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));return;
  }
  // Validate every catalog identity before making any change, then take the
  // existing collector lease so no old worker can overwrite the new request.
  const owner=crypto.randomUUID(),lease=await store.claim(owner),started=Date.now();
  if(!lease?.claimed)throw fail('AUDIT_COLLECTOR_BUSY');
  const assertBudget=()=>{if(Date.now()-started>55000)throw fail('AUDIT_LEASE_BUDGET');};
  try{
  await store.save('series_marker_titles',plan.map(target=>({...canonicalSeries(target.imdb,target.title),year:target.year,inventory_status:'ready',inventory_error:null,inventory_check_at:new Date(Date.now()+7*86400000).toISOString(),updated_at:summary.requestedAt})),'imdb_id');
  await store.save('series_marker_identities',bindings,'provider_key,scope_hash,media_id');
  for(const target of plan){
    const canonical=canonicalSeries(target.imdb,target.title),base={imdb_id:target.imdb,series_slug:canonical.series_slug,tmdb_id:canonical.tmdb_id};
    const inventory=target.episodes.map(episode=>({...base,...episode}));
    for(let start=0;start<inventory.length;start+=300){assertBudget();await store.save('series_marker_coverage',inventory.slice(start,start+300),'imdb_id,season,episode',{ignore:true});}
    const queued=target.requested.map(episode=>({...base,...episode,audit_priority:target.priority,audit_requested_at:summary.requestedAt,audit_next_check_at:summary.requestedAt,audit_checked_at:null,updated_at:summary.requestedAt}));
    for(let start=0;start<queued.length;start+=300){assertBudget();await store.save('series_marker_coverage',queued.slice(start,start+300),'imdb_id,season,episode');}
  }
  await store.bumpVersion();
  summary.applied=true;summary.identitiesWritten=bindings.length;summary.referencesQueued=plan.reduce((count,row)=>count+row.requested.length,0);summary.privateUserWrites=0;summary.playableEditionWrites=0;
  await writeFile('reports/marker-target-refresh-2026-10-15.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
  }finally{await store.release(owner,{state:summary.applied?'ready':'partial',identities:summary.applied?bindings.length:0,inventories:summary.applied?plan.length:0,episodesChecked:0,published:0,elapsedMs:Date.now()-started},{});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({ok:false,code:/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'AUDIT_REFRESH_FAILED'}));process.exitCode=1;});
