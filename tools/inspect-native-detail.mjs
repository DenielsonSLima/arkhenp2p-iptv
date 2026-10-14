import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';

const id=process.argv[2],type=process.argv[3]||'series';
if(!/^\d{1,12}$/.test(id||'')||!['movie','series'].includes(type))throw new Error('INVALID_TARGET');
const credentials=await readWplayCredentials();
const client=new WplayProviderClient({...credentials,authURLs:[WPLAY_AUTH_URLS[1]]});
credentials.username='';credentials.password='';
const emit=value=>console.log(JSON.stringify(value));
const original=client.requestJSON.bind(client);
client.requestJSON=async(url,options={})=>{
  const result=await original(url,options);
  if(new URL(url).pathname.endsWith('/@'+id)) {
    emit({phase:'detail-shape',shape:Array.isArray(result)?'array':result===null?'null':typeof result,
      fields:result&&typeof result==='object'&&!Array.isArray(result)?Object.keys(result).filter(k=>/^[a-z][a-z0-9_]{0,60}$/i.test(k)):[],
      chidType:typeof result?.chid,idType:typeof result?.id,
      chidMatches:String(result?.chid)===id,idMatches:String(result?.id)===id,
      sources:Array.isArray(result?.sources)?result.sources.length:null,
      nameType:typeof result?.name,
      ...(Number.isSafeInteger(result?.code)?{code:result.code}:{}),
    });
  }
  return result;
};
try {
  await client.connect();emit({phase:'login',connected:true});
  try{await client.details(type,id);emit({phase:'parsed',ok:true});}
  catch(error){emit({phase:'parsed',ok:false,code:safeCode(error),status:error.status});}
}catch(error){emit({phase:'failed',code:safeCode(error),status:error.status});process.exitCode=1;}
finally{
  client.authInfo=null;client.session=null;client.config.username='';client.config.password='';
  client.cache.clear();client.rawItems.clear();client.images.clear();client.refs.clear();
}
