import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {WplayProviderClient,WPLAY_AUTH_URLS,wplayServiceURL} from '../lib/wplay/conexao/provedor-nativo.mjs';
const label=v=>typeof v==='string'?v:typeof v==='object'&&v?v.init??v.i18n?.en??'':'';
const safe=v=>String(label(v)).replace(/[\r\n]/g,' ').slice(0,100);
const emit=v=>console.log(JSON.stringify(v));
const client=new WplayProviderClient({...await readWplayCredentials(),authURLs:[WPLAY_AUTH_URLS[1]]});
try{
 await client.connect();
 const groups=await client.requestJSON(client.serviceURL('vod_tag_url'));
 emit({categoryShapes:groups.slice(0,2).map(g=>({name:safe(g.group_name),items:g.items.slice(0,3).map(t=>({id:t._id,categoryId:t.category_id,category:t.category,name:safe(t.name)}))}))});
 const group=groups.find(g=>/s[ée]ri/i.test(safe(g.group_name)));
 const tag=group?.items?.find(t=>typeof t.url==='string');
 if(tag){const base=wplayServiceURL(tag.url,client.authInfo.service.token);const page=await client.requestJSON(base+(base.includes('?')?'&':'?')+'page=1');
 emit({sampleKind:'series',count:page.length,items:page.slice(0,2).map(t=>({id:t.chid,year:t.year,name:safe(t.name),tags:t.tags?.map(t=>({id:t.id,name:safe(t.name)})),sources:t.sources?.slice(0,3).map(s=>({idType:typeof s._id,idShape:/^[a-f\d]{24}$/i.test(String(s._id))?'mongo':/^\d+$/.test(String(s._id))?'numeric':'other',subtitle:safe(s.subTitle),duration:s.duration,scheme:/^([\w+]+):/.exec(s.address||'')?.[1]}))}))});}
}catch(e){emit({error:safeCode(e)});process.exitCode=1;}
finally{client.authInfo=null;client.config.password='';client.config.username='';}
