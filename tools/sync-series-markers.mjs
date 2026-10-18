import {SupabaseCloud} from '../lib/supabase-cloud.mjs';
import {syncSeriesMarkers} from '../lib/serie/marcadores/orquestrador.mjs';

const args=process.argv.slice(2);
if(args.some(value=>!['--apply','--force','--help'].includes(value))){console.error('Opções: --apply, --force, --help');process.exitCode=1;}
else if(args.includes('--help'))console.log('node tools/sync-series-markers.mjs [--force] [--apply]\nLê o dump público SkipDB (cache 24 h), exporta JSON aberto e, com --apply, insere edições próprias no Supabase. Nenhuma API key SkipDB é necessária.');
else try{console.log(JSON.stringify(await syncSeriesMarkers({apply:args.includes('--apply'),force:args.includes('--force'),...(args.includes('--apply')?{cloud:new SupabaseCloud()}:{} )}),null,2));}
catch(error){console.error(error.code||'SKIPDB_SYNC_FAILED');process.exitCode=1;}
