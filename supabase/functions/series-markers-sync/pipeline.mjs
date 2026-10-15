import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';
import {DAY,canonicalSeries,catalogTitle,explicitIdentity,selectSeriesIdentity,episodeInventory,normalizeGlobalDump,inspectSegments} from './metadata.mjs';
import {MarkerProviders,readPublicDump} from './providers.mjs';
import {advanceIncrementalSource} from './incremental.mjs';
import {retainMarkerCaches} from './retention.mjs';

const iso=value=>new Date(value).toISOString(),errorCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'MARKER_SYNC_FAILED';
const markerRow=row=>Object.fromEntries(['series_slug','season','episode','edition_id','tmdb_id','imdb_id','duration_seconds','tolerance_seconds','verification','markers','provenance','data_version','is_active'].map(key=>[key,row[key]]));
export function publicArtifactStream(header,records){
  let index=-1;const encoder=new TextEncoder();return new ReadableStream({pull(controller){
    if(index<0){controller.enqueue(encoder.encode(JSON.stringify(header)+'\n'));index=0;return;}
    if(index>=records.length){controller.close();return;}
    const lines=[];for(let count=0;count<64&&index<records.length;count++,index++){lines.push(JSON.stringify(records[index].type==='reference'?records[index]:markerRow(records[index])));records[index]=null;}
    controller.enqueue(encoder.encode(lines.join('\n')+'\n'));
  }});
}

export async function runMarkerPipeline({store,fetch:request=globalThis.fetch,now=Date.now,providers:givenProviders,skipdbKey='',introdbKey='',budgetMs=42000,loadDump=readPublicDump,normalizeDump=normalizeGlobalDump}={}){
  const owner=crypto.randomUUID(),state=await store.claim(owner);if(!state?.claimed)return {state:'busy'};
  const started=now(),deadline=started+Math.max(1000,Math.min(45000,budgetMs)),room=margin=>now()<deadline-margin;
  const providers=givenProviders||new MarkerProviders({fetch:request,now,skipdbKey,introdbKey,state});
  const result={state:'ready',discovered:0,identities:0,unresolved:0,inventories:0,published:0,episodesChecked:0,skipdb:0,introdb:0,empty:0,unverified:0,failures:0,dumpComplete:false};
  try{
    result.discovered=Number(await store.discover())||0;
    const auditRows=typeof store.auditDue==='function'?await store.auditDue(now(),10):[],prioritizing=auditRows.length>0;
    // These are labelled public reference seeds, not invented provider items.
    await store.save('series_marker_titles',SERIES_MARKER_REGISTRY.map(series=>({...canonicalSeries(series.imdbId,series.title,series.tmdbId)})),'imdb_id',{ignore:true});
    const refreshDue=!state.dump_object||now()-(Date.parse(state.dump_refreshed_at)||0)>=DAY;
    // Full transforms are dependency-injected only for offline bootstrap/tests.
    // The deployed worker always stages bounded source pages and episode groups.
    if(!prioritizing&&loadDump!==readPublicDump&&refreshDue&&room(18000)&&!(Date.parse(state.dump_retry_at)>now())){
      try{
        const dump=await loadDump(request),normalized=await normalizeDump(dump,{now:now(),consume:true});
        const known=new Set(SERIES_MARKER_REGISTRY.map(row=>row.imdbId));normalized.records.sort((a,b)=>Number(known.has(b.imdb_id))-Number(known.has(a.imdb_id))||a.imdb_id.localeCompare(b.imdb_id)||a.season-b.season||a.episode-b.episode||a.duration_seconds-b.duration_seconds);
        const generation=normalized.generatedAt.replace(/[^0-9TZ]/g,''),key='skipdb-'+generation+'.jsonl',editionCount=normalized.records.length;
        const header={type:'metadata',schemaVersion:1,license:normalized.license,licenseUrl:normalized.licenseUrl,sourceUrl:normalized.sourceUrl,generatedAt:normalized.generatedAt,retrievedAt:normalized.retrievedAt,sourceBytes:dump.sourceBytes,sourceCount:dump.sourceCount,selectedSegments:normalized.segments.length,editions:normalized.records.length,missingDuration:normalized.missingDuration,unsupportedEpisodes:normalized.unsupportedEpisodes};
        dump.segments=null;normalized.segments=null;
        const artifactRecords=normalized.records.concat(normalized.references||[]);normalized.records=null;normalized.references=null;await store.uploadDump(key,publicArtifactStream(header,artifactRecords));
        Object.assign(state,{dump_object:key,dump_generation:generation,dump_cursor:0,dump_refreshed_at:iso(now()),dump_retry_at:null,dump_completed_at:null});
        await store.checkpoint(owner,{dump_object:key,dump_generation:generation,dump_cursor:0,dump_refreshed_at:state.dump_refreshed_at,dump_retry_at:null,dump_completed_at:null});
        result.dump={bytes:dump.sourceBytes,sourceSegments:dump.sourceCount,editions:editionCount,publicObject:key};
      }catch(error){result.failures++;result.state='partial';result.dumpError=errorCode(error);await store.checkpoint(owner,{dump_retry_at:iso(now()+900000)});}
    }
    // Range checkpoints and batched inserts run repeatedly within one budget.
    result.dumpComplete=Boolean(state.dump_completed_at);
    let artifactRecords=0;
    publish: if(!prioritizing&&state.dump_object&&state.source_mode!=='incremental'&&!state.dump_completed_at)while(room(6000)&&artifactRecords<4000){
      const page=await store.dumpPage(state.dump_object,Number(state.dump_cursor)||0);
      for(let offset=0;offset<page.records.length;offset+=200){
        if(!room(6000))break publish;
        const batch=page.records.slice(offset,offset+Math.min(200,4000-artifactRecords));
        const titles=[...new Map(batch.map(row=>[row.imdb_id,{...canonicalSeries(row.imdb_id,null,row.tmdb_id),inventory_check_at:SERIES_MARKER_REGISTRY.some(value=>value.imdbId===row.imdb_id)?iso(now()):'9999-01-01T00:00:00.000Z'}])).values()];
        await store.save('series_marker_titles',titles,'imdb_id',{ignore:true});
        const editions=batch.filter(row=>row.type!=='reference'),references=batch.filter(row=>row.type==='reference');
        if(store.url)for(const row of editions)row.provenance={...row.provenance,openDataUrl:store.url+'/storage/v1/object/public/arkhen-marker-open-data/'+state.dump_object};
        if(editions.length)await store.rpc('arkhen_marker_publish',{p_rows:editions,p_generation:state.dump_generation,p_owner:owner});result.published+=editions.length;
        const coverage=new Map();for(const row of editions){const key=[row.imdb_id,row.season,row.episode].join(':'),previous=coverage.get(key),complete=row.markers.openingEnd!==undefined;
          coverage.set(key,{imdb_id:row.imdb_id,series_slug:row.series_slug,tmdb_id:row.tmdb_id,season:row.season,episode:row.episode,status:complete||previous?.status==='ready'?'ready':'unverified',source:'skipdb',skipdb_status:complete?'ready':'partial',next_check_at:iso(now()+(complete?DAY:0)),updated_at:iso(now())});}
        await store.save('series_marker_coverage',[...coverage.values()],'imdb_id,season,episode');
        if(references.length)await store.save('series_marker_coverage',references.map(row=>({imdb_id:row.imdb_id,series_slug:row.series_slug,tmdb_id:row.tmdb_id,season:row.season,episode:row.episode,status:'unverified',source:'skipdb',skipdb_status:'unverified',error_code:'SOURCE_EDITION_DURATION_UNAVAILABLE',evidence:row.evidence,next_check_at:iso(now()+7*DAY),updated_at:iso(now())})),'imdb_id,season,episode',{ignore:true});
        artifactRecords+=batch.length;state.dump_cursor=page.offsets?.[offset+batch.length-1]??page.next;await store.checkpoint(owner,{dump_cursor:state.dump_cursor});
        if(artifactRecords>=4000)break publish;
      }
      state.dump_cursor=page.next;await store.checkpoint(owner,{dump_cursor:page.next});
      if(page.done){await store.rpc('arkhen_marker_finalize',{p_generation:state.dump_generation,p_owner:owner});state.dump_completed_at=iso(now());await store.checkpoint(owner,{dump_completed_at:state.dump_completed_at});result.dumpComplete=true;break;}
    }
    if(!prioritizing&&loadDump===readPublicDump&&room(10000)&&(!state.dump_object||state.dump_completed_at||state.source_mode==='incremental')){
      try{await advanceIncrementalSource({store,state,owner,request,now,room,artifactStream:publicArtifactStream,result});}
      catch(error){result.failures++;result.state='partial';result.dumpError=errorCode(error);await store.checkpoint(owner,{dump_retry_at:iso(now()+900000)});}
    }
    if(!prioritizing&&room(8000))for(const row of await store.due('series_marker_identities','next_check_at',now(),8)){
      if(!room(7000))break;
      try{
        let identity=explicitIdentity(row),status=identity?'resolved':null;
        if(!identity){const response=await providers.search(catalogTitle(row.catalog_name).name);const selected=selectSeriesIdentity(row,response.payload);identity=selected.identity;status=selected.status;}
        if(!identity){result.unresolved++;await store.identity(row,{status,next_check_at:iso(now()+7*DAY),error_code:status==='ambiguous'?'IDENTITY_AMBIGUOUS':'IDENTITY_NOT_FOUND',updated_at:iso(now())});continue;}
        const existing=await store.call('/rest/v1/series_marker_titles?'+new URLSearchParams({select:'*',imdb_id:'eq.'+identity.imdb_id,limit:'1'}));
        await store.save('series_marker_titles',[{imdb_id:identity.imdb_id,series_slug:identity.series_slug,title:identity.title,tmdb_id:identity.tmdb_id,...(identity.year?{year:identity.year}:{}),...(!existing?.length||Date.parse(existing[0].inventory_check_at)>now()+30*DAY?{inventory_check_at:iso(now())}:{})}],'imdb_id');
        await store.identity(row,{status:'resolved',imdb_id:identity.imdb_id,series_slug:identity.series_slug,tmdb_id:identity.tmdb_id,evidence:{method:identity.method,source:identity.method==='skipdb-exact-title-year'?'https://skipdb.tv/api/titles/search':'catalog-or-curated-reference'},error_code:null,next_check_at:iso(now()+30*DAY),updated_at:iso(now())});result.identities++;
      }catch(error){result.failures++;await store.identity(row,{status:'failed',error_code:errorCode(error),next_check_at:iso(now()+900000),updated_at:iso(now())});}
    }
    if(!prioritizing&&room(8000))for(const title of await store.due('series_marker_titles','inventory_check_at',now(),2)){
      if(!room(7000))break;
      try{
        const response=await providers.inventory(title.imdb_id),episodes=response.status==='empty'?[]:episodeInventory(response.payload,title.imdb_id);
        for(let offset=0;offset<episodes.length;offset+=500)await store.save('series_marker_coverage',episodes.slice(offset,offset+500).map(episode=>({...episode,imdb_id:title.imdb_id,series_slug:title.series_slug,tmdb_id:title.tmdb_id})),'imdb_id,season,episode',{ignore:true});
        await store.title(title,{inventory_status:episodes.length?'ready':'empty',inventory_error:null,inventory_check_at:iso(now()+7*DAY),updated_at:iso(now())});result.inventories++;
      }catch(error){result.failures++;await store.title(title,{inventory_status:'failed',inventory_error:errorCode(error),inventory_check_at:iso(now()+900000),updated_at:iso(now())});}
    }
    // Only missing/failed references are queried, once per global episode, then
    // negatively cached. Neither provider is contacted from login or playback.
    if(room(26000))for(const episode of prioritizing?auditRows:await store.due('series_marker_coverage','next_check_at',now(),10,{status:'in.(pending,empty,unverified,failed)',audit_priority:'eq.0'})){
      if(!room(26000))break;const outcomes={},evidence={};let selected=null,failed=false;
      for(const source of ['skipdb','introdb']){
        try{
          const response=await providers.segments(source,episode);outcomes[source]=response.status==='empty'?{status:'empty',evidence:{}}:inspectSegments(source,response.payload,episode);
          evidence[source]=outcomes[source].evidence;
          if(Object.keys(outcomes[source].evidence).length){if(!outcomes.skipdb?.evidence?.intro||source==='skipdb')selected=source;if(source==='skipdb')result.skipdb++;else result.introdb++;}
          // The API lacks edition duration; try the fallback for a missing intro
          // or a source failure, never to overwrite a compatible primary pair.
          if(source==='skipdb'&&outcomes[source].evidence.intro&&!(Number(episode.audit_priority)>0))break;
        }catch(error){outcomes[source]={status:'failed',code:errorCode(error)};failed=true;}
      }
      const hasEvidence=Object.values(evidence).some(value=>Object.keys(value).length),status=episode.status==='ready'?'ready':hasEvidence?'unverified':failed?'failed':'empty';
      // Preserve independent edition coverage and evidence when an audit source
      // fails. A completed API audit is never an audiovisual verification.
      const mergedEvidence={...(episode.evidence||{}),...evidence};
      if(Number(episode.audit_priority)>0)mergedEvidence.audit={requestedAt:episode.audit_requested_at,checkedAt:iso(now()),completed:!failed,editionVerified:false,numbering:'source-native',sources:Object.fromEntries(Object.entries(outcomes).map(([source,value])=>[source,{status:value.status,...(value.code?{code:value.code}:{})}]))};
      const written=await store.coverage(episode,{status,source:episode.status==='ready'?episode.source:selected,skipdb_status:outcomes.skipdb?.status||null,introdb_status:outcomes.introdb?.status||null,
        error_code:failed?Object.values(outcomes).find(value=>value.code)?.code:hasEvidence?'SOURCE_EDITION_DURATION_UNAVAILABLE':null,evidence:mergedEvidence,attempts:Number(episode.attempts||0)+1,next_check_at:iso(now()+(failed?900000:7*DAY)),updated_at:iso(now()),
        ...(Number(episode.audit_priority)>0?failed?{audit_next_check_at:iso(now()+900000)}:{audit_priority:0,audit_next_check_at:null,audit_checked_at:iso(now())}:{})});
      if(written===false)continue;
      result.episodesChecked++;if(status==='empty')result.empty++;if(status==='unverified')result.unverified++;if(failed)result.failures++;
    }
    if(!prioritizing&&state.dump_completed_at&&room(18000)&&typeof store.storageRemove==='function'){
      try{result.retention=await retainMarkerCaches({store,owner,now,room});}
      catch(error){result.retentionError=errorCode(error);result.state='partial';}
    }
    if(result.failures)result.state='partial';return result;
  }catch(error){result.state='failed';result.code=errorCode(error);return result;}
  finally{
    try{if(result.published||result.identities||result.unresolved||result.episodesChecked||result.failures||result.cacheChanged)await store.bumpVersion?.();}
    catch{result.state='partial';result.versionError='MARKER_CACHE_VERSION_FAILED';}
    finally{result.elapsedMs=now()-started;if(typeof providers.health==='function')result.providerStatus=providers.health();await store.release(owner,result,providers.cooldowns||{});}
  }
}
