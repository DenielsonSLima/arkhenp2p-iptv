const MAX_CHANNELS=2000;
const failure=code=>Object.assign(new Error('A programação não pôde ser atualizada.'),{code});
export const authorizedWplayLiveSession=(client,now)=>{
  const account=client?.session?.account,expires=account?.expiresAt,validated=Number(client?.authenticatedAt);
  return Boolean(client?.session?.connected&&String(account?.status||'').toLowerCase()==='active'&&(!expires||Number.isFinite(Date.parse(expires))&&Date.parse(expires)>now)&&Number.isFinite(validated)&&validated>0&&validated<=now+60000&&now-validated<=86400000);
};

/** Source discovery and its parental check share the same account catalogue.
 * Keep the source cache's 15-minute lifetime without refreshing provider auth. */
export async function readWplayLiveSourceCatalog(client,{current=()=>true,now=Date.now}={}){
  const cached=client.cache?.get('catalog:live'),auth=client.authInfo,session=client.session;
  const fresh=Boolean(cached&&(!Number.isFinite(cached.time)||now()-cached.time>=900000));
  const catalog=await readWplayLiveCatalog(client,{current,now,fresh,maxChannels:null});
  if(!current()||client.authInfo!==auth||client.session!==session||!authorizedWplayLiveSession(client,now()))throw failure('WPLAY_EPG_SOURCE_CANCELLED');
  return catalog;
}

/** Reuse only this account's authorized live catalog. When absent, read ch_url
 * with its EXISTING token; catalog()/connect() would create an unrelated login. */
export async function readWplayLiveCatalog(client,{current=()=>true,fresh=false,now=Date.now,maxChannels=MAX_CHANNELS}={}){
  const auth=client?.authInfo,session=client?.session,sourceCurrent=()=>current()&&client?.authInfo===auth&&client?.session===session&&authorizedWplayLiveSession(client,now())&&client.authInfo?.service?.enabledLive!==false;
  if(!sourceCurrent())throw failure('WPLAY_EPG_SOURCE_UNAVAILABLE');
  if(fresh)client.cache?.delete('catalog:live');
  const cached=client.cache?.get('catalog:live');
  if(cached?.promise)return cached.promise;
  if(!client.authInfo?.service?.ch_url||typeof client.normalizeItems!=='function')throw failure('WPLAY_EPG_CATALOG_UNAVAILABLE');
  const entry={time:now(),promise:null};
  entry.promise=Promise.resolve().then(()=>client.requestJSON(client.serviceURL('ch_url'),{timeout:8000})).then(payload=>{
    if(!sourceCurrent())throw failure('WPLAY_EPG_SOURCE_CANCELLED');
    if(!Array.isArray(payload)||maxChannels!==null&&payload.length>maxChannels)throw failure('WPLAY_EPG_CATALOG_INVALID');
    return client.normalizeItems(payload,'live');
  });
  client.cache.set('catalog:live',entry);
  void entry.promise.catch(()=>{if(client.cache.get('catalog:live')===entry)client.cache.delete('catalog:live');});
  return entry.promise;
}

