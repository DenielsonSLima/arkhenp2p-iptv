import {mkdir,writeFile} from 'node:fs/promises';
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';
import {requestUpstream,readBody} from '../lib/upstream.mjs';
const client=new WplayProviderClient({...await readWplayCredentials(),authURLs:[WPLAY_AUTH_URLS[1]]});
const dir='/private/tmp/arkhen-artwork-check';
try {
 await mkdir(dir,{recursive:true});await client.connect();
 for(const type of ['movies','series','live']){
  const data=await client.catalog(type),item=data.items[0],raw=client.rawItems.get(`${item.kind}:${item.id}`);
  console.log(JSON.stringify({type,name:item.name,fields:Object.keys(raw).filter(key=>/image|logo|cover|poster|art|pic/i.test(key)),logoKeys:Object.keys(raw.logo||{}),imageKeys:Object.keys(raw.logo?.image||{})}));
  const candidates={image_logo:raw.image_logo,image_backdrop:raw.image_backdrop,...Object.fromEntries(Object.entries(raw.logo?.image||{}).map(([key,value])=>['logo_'+key,value]))};
  for(const [key,url]of Object.entries(candidates)){
   if(typeof url!=='string'||!/^https?:/.test(url))continue;
   try{const response=await requestUpstream(url,{headers:client.upstreamHeaders()});const buffer=await readBody(response,5*1024*1024);if(response.status===200&&/^image\//.test(response.headers['content-type']||'')){const file=`${dir}/${type}-${key}.img`;await writeFile(file,buffer);console.log(JSON.stringify({type,key,bytes:buffer.length,file}));}else console.log(JSON.stringify({type,key,status:response.status}));}catch(error){console.log(JSON.stringify({type,key,error:safeCode(error)}));}
  }
 }
}catch(error){console.log(JSON.stringify({error:safeCode(error)}));process.exitCode=1;}
finally{client.config.password='';client.config.username='';client.authInfo=null;}
