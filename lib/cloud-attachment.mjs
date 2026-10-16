/** Cloud provisioning continues independently of the local TV response. */
export function createCloudAttachment(runtime,{budgetMs=1500,retryMs=30000,now=()=>Date.now()}={}){
  const entries=new WeakMap();
  return async function attach(state,session,client,generation=state.authGeneration){
    const account=session?.account,expiry=account?.expiresAt;
    // Explicit denials and expiry must still revoke local/cloud access promptly.
    if(!session?.connected||String(account?.status||'').toLowerCase()!=='active'||expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=now()))return runtime.attach(state,session,client,generation);
    const key=JSON.stringify([generation,account?.libraryId,expiry,client.authenticatedAt]);
    let entry=entries.get(state);
    if(!entry||entry.client!==client||entry.key!==key||!entry.pending&&(state.cloud||entry.retryAt<=now())){
      entry={client,key,pending:true,retryAt:Infinity,promise:null};entries.set(state,entry);
      entry.promise=Promise.resolve().then(()=>runtime.attach(state,session,client,generation)).catch(()=>null).finally(()=>{entry.pending=false;entry.retryAt=now()+retryMs;});
    }
    if(!entry.pending)return state.cloud||null;
    let timer;
    try{return await Promise.race([entry.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),budgetMs);timer.unref?.();})]);}
    finally{clearTimeout(timer);}
  };
}
