import {readFile,mkdir,stat} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {normalizeGlobalDump,LICENSE} from '../supabase/functions/series-markers-sync/metadata.mjs';
import {readPublicDump} from '../supabase/functions/series-markers-sync/conectores/dump.mjs';
import {publicArtifactStream} from '../supabase/functions/series-markers-sync/pipeline.mjs';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
import {SERIES_MARKER_REGISTRY} from '../web/series-markers/registry.js';

const project='wnicimkmzswksaqdtgdv',url='https://'+project+'.supabase.co',args=process.argv.slice(2),upload=args.includes('--upload');
let source=null;for(let index=0;index<args.length;index++){if(args[index]==='--source'){source=args[++index];if(!source)throw new Error('SOURCE_PATH_REQUIRED');}else if(!['--upload','--help'].includes(args[index]))throw new Error('UNKNOWN_OPTION');}
if(args.includes('--help')){console.log('node tools/bootstrap-marker-open-data.mjs [--source .local/skipdb/dump.json] [--upload]\nBuilds a sanitized licensed JSONL artifact locally. --upload stores that public artifact and initializes the global cloud publication cursor. Admin credentials are captured only in memory.');process.exit(0);}
function adminKey(){
  if(process.env.SUPABASE_SERVICE_ROLE_KEY)return process.env.SUPABASE_SERVICE_ROLE_KEY;
  let text;try{text=execFileSync(resolve('.local/bin/supabase.exe'),['projects','api-keys','--project-ref',project,'--reveal','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:4*1024*1024});}catch{throw new Error('BOOTSTRAP_KEY_LOOKUP_FAILED');}
  let parsed;try{parsed=JSON.parse(text);}catch{throw new Error('BOOTSTRAP_KEY_RESPONSE_INVALID');}
  const keys=Array.isArray(parsed)?parsed:parsed.keys||parsed.data||[],entry=keys.find(value=>value.name==='service_role'||value.role==='service_role');
  const key=entry?.api_key??entry?.key;if(typeof key!=='string'||!key.startsWith('eyJ'))throw new Error('BOOTSTRAP_SERVICE_ROLE_REQUIRED');return key;
}
try{
  let dump;if(source){const cached=JSON.parse(await readFile(source,'utf8'));dump=cached.dump||cached;}else dump=await readPublicDump();
  const now=Date.now(),normalized=await normalizeGlobalDump(dump,{now,consume:true}),known=new Set(SERIES_MARKER_REGISTRY.map(row=>row.imdbId));
  normalized.records.sort((a,b)=>Number(known.has(b.imdb_id))-Number(known.has(a.imdb_id))||a.imdb_id.localeCompare(b.imdb_id)||a.season-b.season||a.episode-b.episode||a.duration_seconds-b.duration_seconds);
  const generation=normalized.generatedAt.replace(/[^0-9TZ]/g,''),object='skipdb-'+generation+'.jsonl',directory=resolve('.local'),file=join(directory,'marker-bootstrap-'+generation+'.jsonl');
  const editions=normalized.records.length,series=new Set([...normalized.records,...normalized.references].map(row=>row.imdb_id)).size;
  const header={type:'metadata',schemaVersion:1,license:LICENSE,licenseUrl:'https://skipdb.tv/license',sourceUrl:'https://skipdb.tv/api/dump',generatedAt:normalized.generatedAt,retrievedAt:new Date(now).toISOString(),editions,series,missingDuration:normalized.missingDuration,unsupportedEpisodes:normalized.unsupportedEpisodes};
  await mkdir(directory,{recursive:true});const rows=normalized.records.concat(normalized.references);dump.segments=null;normalized.records=null;normalized.references=null;normalized.segments=null;
  await pipeline(Readable.fromWeb(publicArtifactStream(header,rows)),createWriteStream(file));
  const bytes=(await stat(file)).size;let publicURL=null;
  if(upload){
    const store=new MarkerStore({url,key:adminKey(),uploadTimeoutMs:60000}),owner=crypto.randomUUID(),claim=await store.rpc('arkhen_marker_claim',{p_owner:owner,p_lease_seconds:90});if(!claim?.claimed)throw new Error('BOOTSTRAP_COLLECTOR_BUSY');
    try{
      publicURL=await store.uploadDump(object,Readable.toWeb(createReadStream(file)));
      await store.checkpoint(owner,{source_mode:'artifact',dump_object:object,dump_generation:generation,dump_cursor:0,dump_refreshed_at:new Date(now).toISOString(),dump_completed_at:null,dump_retry_at:null});
      const confirmed=await store.call('/rest/v1/series_marker_sync_state?select=dump_object&name=eq.global');if(confirmed?.[0]?.dump_object!==object)throw new Error('BOOTSTRAP_CHECKPOINT_NOT_CONFIRMED');
    }finally{await store.release(owner,{state:'bootstrap-ready',editions,series,bytes},{});}
  }
  console.log(JSON.stringify({state:upload?'uploaded':'built',file,bytes,editions,series,publicURL}));
}catch(error){console.error(/^[A-Z0-9_]+$/.test(error?.message||'')?error.message:'MARKER_BOOTSTRAP_FAILED');process.exitCode=1;}
