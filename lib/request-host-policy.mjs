const LOCAL_HOST=/^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const VERCEL_HOST_KEYS=['VERCEL_URL','VERCEL_BRANCH_URL','VERCEL_PROJECT_PRODUCTION_URL'];
const DNS_LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function configuredHost(value){
  if(typeof value!=='string'||!value||value.length>300||/[\s\\/?#@%]/.test(value))return null;
  try{
    const url=new URL('https://'+value);
    if(!url.hostname||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
    if(!url.hostname.startsWith('[')&&!url.hostname.split('.').every(label=>DNS_LABEL.test(label)))return null;
    // Refuse URL parser repairs and numeric host aliases; DNS case is harmless.
    // HTTPS's explicit default port is equivalent to the canonical origin.
    if(url.host!==value.toLowerCase()&&url.host+':443'!==value.toLowerCase())return null;
    return url.host;
  }catch{return null;}
}

function publicOriginHost(value){
  if(typeof value!=='string'||/\s/.test(value))return null;
  const match=/^https:\/\/([^/?#\\\s]+)\/?$/i.exec(value);
  return match?configuredHost(match[1]):null;
}

/** Snapshot each app's trusted authorities. Forwarded headers and domain
 * suffixes never grant trust; malformed or missing entries add no host. */
export function createRequestHostPolicy(environment={}){
  const hosts=new Set();
  const publicHost=publicOriginHost(environment?.ARKHEN_PUBLIC_ORIGIN);
  if(publicHost)hosts.add(publicHost);
  if(environment?.VERCEL==='1')for(const key of VERCEL_HOST_KEYS){
    const host=configuredHost(environment[key]);
    if(host)hosts.add(host);
  }
  return host=>typeof host==='string'&&(LOCAL_HOST.test(host)||hosts.has(host.toLowerCase()));
}
