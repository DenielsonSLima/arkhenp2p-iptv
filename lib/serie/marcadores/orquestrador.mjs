import {resolve,join} from 'node:path';
import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';
import {failure} from './contrato.mjs';
import {loadSkipDBDump} from './skipdb.mjs';
import {normalizeSkipDBDump} from './normalizacao.mjs';
import {atomicJSON} from './arquivos.mjs';
import {applySkipDBRows} from './supabase.mjs';

/** Public derivative JSON is updated before DB publication at the same cadence. */
export async function syncSeriesMarkers({cloud,apply=false,registry=SERIES_MARKER_REGISTRY,outputDir=resolve('web/series-markers/open-data'),signal,...options}={}){
  const loaded=await loadSkipDBDump({...options,signal});if(signal?.aborted)throw failure('SKIPDB_SYNC_ABORTED');
  const result=normalizeSkipDBDump(loaded.dump,{registry,retrievedAt:loaded.retrievedAt});
  await atomicJSON(join(outputDir,'skipdb.json'),result.snapshot);
  for(const [slug,manifest]of Object.entries(result.manifests)){if(signal?.aborted)throw failure('SKIPDB_SYNC_ABORTED');await atomicJSON(join(outputDir,slug,'manifest.json'),manifest);}
  const publication=apply?await applySkipDBRows(cloud,result.rows,{slugs:registry.map(series=>series.slug),signal}):null;
  return {...result.stats,cacheHit:loaded.cacheHit,generatedAt:loaded.dump.generated_at,publication};
}
