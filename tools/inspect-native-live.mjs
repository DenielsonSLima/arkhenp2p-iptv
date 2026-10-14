import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';
import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
const client=new WplayProviderClient({...await readWplayCredentials(),authURLs:[WPLAY_AUTH_URLS[1]]});
try{
 await client.connect();const catalog=await client.catalog('live'),schemes={},fields=new Set(),samples=[];
 for(const item of catalog.items){
  for(const source of client.sources(client.rawItems.get('live:'+item.id))){
   for(const [key,value]of Object.entries(source)){
    fields.add(key);if(typeof value!=='string')continue;
    const scheme=/^([a-z][a-z\d+.-]*):/i.exec(value)?.[1];if(!scheme)continue;
    const name=key+':'+scheme;schemes[name]=(schemes[name]||0)+1;
    if(/^https?$/.test(scheme))samples.push({channel:item.name,field:key});
   }
  }
 }
 console.log(JSON.stringify({channels:catalog.items.length,sourceFields:[...fields],schemes,httpSamples:samples.slice(0,10),serviceFieldNames:Object.keys(client.authInfo.service||{})}));
}catch(error){console.log(JSON.stringify({error:safeCode(error)}));process.exitCode=1;}
finally{client.config.username='';client.config.password='';client.authInfo=null;}
