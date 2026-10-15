const encoder=new TextEncoder(),decoder=new TextDecoder();
const fail=()=>Object.assign(new Error('PROVIDER_SOURCE_INVALID'),{code:'PROVIDER_SOURCE_INVALID'});
const base64=bytes=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const bytes=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw fail();try{return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));}catch{throw fail();}};
const hash=/^[a-f0-9]{64}$/;
function associated(providerKey,scopeHash,sourceId){if(![providerKey,scopeHash,sourceId].every(value=>hash.test(value||'')))throw fail();return encoder.encode(`${providerKey}:${scopeHash}:${sourceId}`);}
async function aes(key,usage){const raw=bytes(key);if(raw.length!==32)throw fail();return crypto.subtle.importKey('raw',raw,'AES-GCM',false,[usage]);}
export async function sealSource({source,providerKey,scopeHash,sourceId,key}){
  const iv=crypto.getRandomValues(new Uint8Array(12)),data=encoder.encode(JSON.stringify(source));if(data.length>90000)throw fail();
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:associated(providerKey,scopeHash,sourceId)},await aes(key,'encrypt'),data);
  return {version:1,iv:base64(iv),ciphertext:base64(new Uint8Array(ciphertext))};
}
export async function openSource(row,key){
  try{
    if(!row||Date.parse(row.expires_at)<=Date.now()||!Number.isFinite(Date.parse(row.expires_at)))throw fail();
    const value=row.cipher;if(value?.version!==1)throw fail();const iv=bytes(value.iv),ciphertext=bytes(value.ciphertext);if(iv.length!==12||ciphertext.length>100000)throw fail();
    const data=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:associated(row.provider_key,row.scope_hash,row.source_id??row.ref)},await aes(key,'decrypt'),ciphertext);
    return JSON.parse(decoder.decode(data));
  }catch{throw fail();}
}
export function publicProviderURL(value){
  let url;try{url=new URL(value);}catch{throw fail();}
  const host=url.hostname.toLowerCase().replace(/\.+$/,''),ipv4=/^\d+\.\d+\.\d+\.\d+$/.test(host)?host.split('.').map(Number):null;
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||host.includes(':')||!host.includes('.')||/(?:^|\.)(localhost|local|internal|invalid|test|example|arpa)$/.test(host)||host==='metadata.google.internal')throw fail();
  if(ipv4&&(ipv4[0]===0||ipv4[0]===10||ipv4[0]===127||ipv4[0]>=224||ipv4[0]===169&&ipv4[1]===254||ipv4[0]===172&&ipv4[1]>=16&&ipv4[1]<=31||ipv4[0]===192&&ipv4[1]===168||ipv4[0]===100&&ipv4[1]>=64&&ipv4[1]<=127||ipv4[0]===198&&[18,19].includes(ipv4[1])))throw fail();
  url.hostname=host;return url;
}
function publicResolvedAddress(value){
  if(typeof value!=='string')return false;
  if(value.includes(':'))return /^[0-9a-f:]+$/i.test(value)&&/^[23][0-9a-f]{3}:/i.test(value)&&!/^2001:(?:db8|0):/i.test(value);
  try{publicProviderURL('https://'+value+'/');return /^\d+\.\d+\.\d+\.\d+$/.test(value);}catch{return false;}
}
/** Validate both DNS families before every upstream origin. Fetch uses manual
 * redirects, so a provider cannot redirect the collector to an internal host. */
export async function assertPublicProviderDestination(value,{resolveDns=globalThis.Deno?.resolveDns}={}){
  const url=publicProviderURL(value);
  if(/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))return url;
  if(typeof resolveDns!=='function')throw fail();
  let timer;
  try{
    const records=await Promise.race([
      Promise.allSettled(['A','AAAA'].map(type=>resolveDns(url.hostname,type))).then(results=>results.filter(result=>result.status==='fulfilled').flatMap(result=>result.value)),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail()),3000);timer?.unref?.();})
    ]);
    if(!records.length||records.some(address=>!publicResolvedAddress(address)))throw fail();return url;
  }finally{clearTimeout(timer);}
}
