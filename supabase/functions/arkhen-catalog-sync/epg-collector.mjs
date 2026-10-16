const failure=code=>Object.assign(new Error(code),{code});
const encoder=new TextEncoder();

/** Capture the complete sanitized guide before any public row can change.
 * A sealed retry reads only its durable candidate, never the provider source. */
export async function collectEPGSnapshot({store,job,worker,now,started,budgetMs,renew,openClient}){
  let state=await store.epgState(job,worker),steps=0;
  if(state?.state==='missing'){
    const client=await openClient();
    const data=await client.epg();
    if(!Array.isArray(data?.channels)||!data.channels.length)throw failure('COLLECTOR_EPG_INVALID');
    const channels=data.channels.map(row=>({channel_id:String(row.channel_id),payload:row.payload}));
    const bytes=encoder.encode(JSON.stringify(channels));
    if(bytes.byteLength>32*1024*1024)throw failure('COLLECTOR_EPG_TOO_LARGE');
    const contentHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
    await renew();
    state=await store.epgStage(job,worker,{channels,contentHash,fetchedAt:new Date(now()).toISOString()});
    steps++;
  }
  if(!['sealed','published','superseded'].includes(state?.state))throw failure('COLLECTOR_EPG_STATE_INVALID');
  if(state.state==='sealed'){
    // Capturing persisted the WHOLE guide in one transaction. A subsequent
    // invocation can publish it even if the source has expired meanwhile.
    if(now()-started>=budgetMs){await store.yield(job,worker,{epgSnapshotId:state.snapshotId,epgState:'sealed'});return {completed:false,yielded:true,steps};}
    await renew();state=await store.epgPublish(job,worker);steps++;
  }
  if(!['published','superseded'].includes(state?.state))throw failure('COLLECTOR_EPG_PUBLICATION_INCOMPLETE');
  return {completed:true,yielded:false,steps};
}
