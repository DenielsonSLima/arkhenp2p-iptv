import {SupabaseCloud,normalizeCloudConfig} from './supabase-cloud.mjs';

/** Imports stay disconnected. Hosted instances accept only server environment
 * configuration; only direct local execution may consult the private file. */
export function createRuntimeCloud({executable=false,environment=process.env,onConfigurationError=()=>{}}={}){
  if(environment.VERCEL!=='1')return executable?new SupabaseCloud():null;
  const raw=environment.ARKHEN_SUPABASE_CONFIG;
  if(raw===undefined||raw==='')return null;
  let config;
  try{
    if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>32768)throw new Error('Invalid configuration size');
    const value=JSON.parse(raw);
    if(value?.enabled===false)return null;
    config=normalizeCloudConfig(value);
  }catch(error){
    // JSON/parser messages and supplied values may contain credentials. Only
    // these fixed diagnostic codes are allowed outside this private boundary.
    onConfigurationError({code:error?.code==='CLOUD_PROJECT_MISMATCH'?'CLOUD_PROJECT_MISMATCH':'CLOUD_CONFIG_INVALID'});
    return null;
  }
  return new SupabaseCloud({config});
}
