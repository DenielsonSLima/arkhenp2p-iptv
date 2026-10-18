import {createHash} from 'node:crypto';
import {validCatalogPublication} from './catalog-snapshot-reader.mjs';

const HASH=/^[a-f0-9]{64}$/i;

/** Publication metadata only. This path never downloads a catalogue, contacts
 * WPLAY, enqueues a job or renews Auth. Failure leaves the device snapshot old. */
export class CatalogRevisionService{
  constructor({cloud,now=()=>Date.now(),enabled=()=>true,closed=()=>false,maxEntries=256}={}){
    Object.assign(this,{cloud,now,enabled,closed,maxEntries});this.reads=new Map();
  }
  async read(state,type,{signal}={}){
    const account=state.cloud,client=state.client,generation=state.authGeneration;
    if(!this.enabled()||this.closed()||!['live','movies','series'].includes(type)||typeof account?.session?.access_token!=='string'||!account.session.access_token||!HASH.test(account.providerKey||'')||!HASH.test(account.scopeHash||''))return null;
    const unlocked=state.parental?.unlocked===true;
    const current=()=>!this.closed()&&state.client===client&&state.authGeneration===generation&&state.cloud===account&&(state.parental?.unlocked===true)===unlocked&&!signal?.aborted;
    const {providerKey,scopeHash}=account;
    // Runtime restoration creates new account/client objects on every HTTP
    // request. Scope the cache to the same authorization proof instead of its
    // object identity; a rejected token cannot suppress another viewer's read.
    // The digest stays in process memory and is never returned or logged.
    const proof=createHash('sha256').update(account.session.access_token).digest('hex');
    const key=JSON.stringify([providerKey,scopeHash,type,generation,proof]);
    for(const [ref,entry]of this.reads)if(!entry.inFlight&&entry.expiresAt<=this.now())this.reads.delete(ref);
    let entry=this.reads.get(key);
    if(!entry){
      entry={inFlight:true,expiresAt:Infinity,promise:null};
      const params=new URLSearchParams({select:'is_complete,snapshot_id,index_generation,updated_at,expires_at,item_count,safe_item_count',provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,media_type:'eq.'+type,limit:'1'});
      entry.promise=Promise.resolve().then(()=>this.cloud.request('/rest/v1/provider_catalog_cache?'+params,{publicKey:true,accessToken:account.session.access_token,timeoutMs:3000}))
        .then(rows=>Array.isArray(rows)&&rows.length===1&&validCatalogPublication(rows[0])?rows[0]:null)
        .catch(()=>null).then(row=>{entry.expiresAt=this.now()+(row?1000:30000);return row;})
        .finally(()=>{entry.inFlight=false;});
      this.reads.set(key,entry);
      while(this.reads.size>this.maxEntries)this.reads.delete(this.reads.keys().next().value);
    }
    const row=await entry.promise;if(!row||!current())return null;
    return {mediaType:type,snapshotId:row.snapshot_id,revisionAt:new Date(row.updated_at).toISOString(),expiresAt:row.expires_at,includeAdult:unlocked,complete:true};
  }
  close(){this.reads.clear();}
}
