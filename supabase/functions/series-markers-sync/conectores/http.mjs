const encoder=new TextEncoder();
const failure=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
const wait=delay=>new Promise(resolve=>setTimeout(resolve,delay));
export class MarkerHttp{
  constructor({fetch:request=globalThis.fetch,now=Date.now,sleep=wait,skipdbKey='',introdbKey='',state={}}={}){
    Object.assign(this,{request,now,sleep,skipdbKey,introdbKey});this.last={};this.cooldowns={skipdb:Date.parse(state.skipdb_cooldown_until)||0,introdb:Date.parse(state.introdb_cooldown_until)||0};
    this.providerStatus={};
    for(const source of ['skipdb','introdb']){
      const previous=state.last_result?.providerStatus?.[source]||{},value={configured:Boolean(source==='skipdb'?skipdbKey:introdbKey)};
      for(const field of ['lastCheckedAt','lastSuccessAt'])if(typeof previous[field]==='string'&&/^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(previous[field]))value[field]=previous[field];
      value.errorCode=/^PROVIDER_[A-Z0-9_]{1,60}$/.test(previous.errorCode||'')?previous.errorCode:null;
      this.providerStatus[source]=value;
    }
  }
  async json(source,path,{metadata=false}={}){
    if(!['skipdb','introdb'].includes(source))throw failure('PROVIDER_INVALID');
    const status=this.providerStatus[source];
    try{
      // A cooldown is a queued retry, not a new request or a successful check.
      if(this.cooldowns[source]<=this.now())status.lastCheckedAt=new Date(this.now()).toISOString();
      const result=await this.requestJson(source,path,{metadata});
      status.lastSuccessAt=new Date(this.now()).toISOString();status.errorCode=null;return result;
    }catch(error){status.errorCode=/^PROVIDER_[A-Z0-9_]{1,60}$/.test(error?.code||'')?error.code:'PROVIDER_NETWORK_FAILED';throw error;}
  }
  health(){return Object.fromEntries(Object.entries(this.providerStatus).map(([source,value])=>[source,{...value}]));}
  async requestJson(source,path,{metadata=false}={}){
    if(this.cooldowns[source]>this.now())throw failure('PROVIDER_COOLDOWN',{source,retryAt:this.cooldowns[source]});
    const rateKey=source+(metadata?'-metadata':'-segments'),interval=metadata?2100:source==='introdb'?1100:550;
    await this.sleep(Math.max(0,(this.last[rateKey]||0)+interval-this.now()));this.last[rateKey]=this.now();
    const base=source==='introdb'?'https://api.introdb.app':metadata?'https://skipdb.tv':'https://api.skipdb.tv';
    const headers={Accept:'application/json'},key=source==='skipdb'?this.skipdbKey:this.introdbKey;if(key)headers['X-API-Key']=key;
    let response;try{response=await this.request(base+path,{headers,signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw failure('PROVIDER_NETWORK_FAILED',{source});}
    if(response.status===404)return {status:'empty',payload:null};
    if(response.status===429||response.status===503){const retry=response.headers.get('retry-after'),seconds=/^\d+$/.test(retry||'')?Number(retry):Math.max(0,(Date.parse(retry)||0)-this.now())/1000;
      const retryAt=this.now()+Math.max(60000,Math.min(3600000,(seconds||60)*1000));this.cooldowns[source]=retryAt;throw failure('PROVIDER_RATE_LIMITED',{source,retryAt});}
    if(!response.ok)throw failure(response.status===401||response.status===403?'PROVIDER_AUTH_FAILED':'PROVIDER_HTTP_FAILED',{source});
    const body=await response.text();if(encoder.encode(body).length>4*1024*1024)throw failure('PROVIDER_RESPONSE_TOO_LARGE',{source});
    let payload;try{payload=JSON.parse(body);}catch{throw failure('PROVIDER_RESPONSE_INVALID',{source});}
    if(payload?.error)throw failure('PROVIDER_RESPONSE_INVALID',{source});return {status:'ok',payload};
  }
}
