import {readFile} from 'node:fs/promises';

/** Explicit hosted configuration is supplied by createApp; only local startup reads this file. */
export async function configuredConnection({environment=process.env,read=readFile,location=new URL('../../../.local/connection.json',import.meta.url)}={}){
  if(environment.IPTV_SERVER&&environment.IPTV_USERNAME&&environment.IPTV_PASSWORD)return {server:environment.IPTV_SERVER,username:environment.IPTV_USERNAME,password:environment.IPTV_PASSWORD};
  try{return JSON.parse(await read(location,'utf8'));}catch{return null;}
}
