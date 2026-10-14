import {readWplayCredentials,safeCode} from './wplay-tool-input.mjs';
import {WplayProviderClient,WPLAY_AUTH_URLS} from '../lib/wplay-provider.mjs';
import {requestUpstream,readBody} from '../lib/upstream.mjs';

const emit=value=>console.log(JSON.stringify(value));
const credentials=await readWplayCredentials();
const client=new WplayProviderClient({...credentials,authURLs:[WPLAY_AUTH_URLS[1]]});
credentials.username='';credentials.password='';
const fields=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).filter(k=>/^[a-z][a-z\d_]{0,60}$/i.test(k)):[];
const stampType=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)?'iso-utc':typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*[+-]\d\d:?\d\d$/.test(value)?'iso-offset':typeof value;
let response;
try {
  await client.connect();emit({phase:'login',connected:true,hasEPG:!!client.authInfo?.service?.epg_url});
  if(!client.authInfo?.service?.epg_url)process.exitCode=1;
  else {
    const start=performance.now();
    response=await requestUpstream(client.serviceURL('epg_url'),{headers:client.upstreamHeaders(),timeout:20000,followRedirects:false});
    const bytes=await readBody(response,32*1024*1024);
    let data;try{data=JSON.parse(bytes.toString());}catch{}
    const rows=Array.isArray(data)?data:[],valid=rows.filter(r=>Number.isSafeInteger(r?.id)&&r.id>0&&Array.isArray(r.epg));
    const programs=valid.flatMap(row=>row.epg),sample=programs.find(p=>p&&typeof p==='object');
    const now=Date.now(),current=programs.filter(p=>Date.parse(p?.time)<=now&&Date.parse(p?.endTime)>now);
    emit({phase:'epg',status:response.status,mime:response.headers['content-type'],encoding:response.headers['content-encoding']||'identity',
      bytes:bytes.length,ms:Math.round(performance.now()-start),shape:Array.isArray(data)?'array':data===null?'null':typeof data,
      channels:rows.length,validChannels:valid.length,programs:programs.length,currentPrograms:current.length,
      rowFields:fields(rows[0]),programFields:fields(sample),timeType:stampType(sample?.time),endTimeType:stampType(sample?.endTime)});
    bytes.fill(0);
  }
}catch(error){emit({phase:'failed',code:safeCode(error),status:error.status});process.exitCode=1;}
finally{response?.body.destroy();client.authInfo=null;client.session=null;client.config.username='';client.config.password='';}
