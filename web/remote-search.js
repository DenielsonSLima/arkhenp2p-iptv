import {canSearchGlobally,normalizeSearchText} from './global-search.js';
import {withRequestSignals} from './request-signals.js';

const TYPES=new Set(['all','live','movies','series']);
const empty=()=>({query:'',type:'all',phase:'idle',data:null,error:null});
const scopeKey=scope=>JSON.stringify(scope||{});
const errorMessage=error=>error?.status===401?'Entre novamente para pesquisar no catálogo.':'Não foi possível concluir a busca. Tente novamente.';
const abort=()=>new DOMException('Busca cancelada.','AbortError');
const localSource=data=>['local','local-cache','client-snapshot'].includes(data?.source);
const transientRequest=error=>error?.name!=='AbortError'&&(
  [500,502,503,504].includes(error?.status)||error?.status===undefined&&(
    error instanceof TypeError||['NetworkError','TimeoutError'].includes(error?.name)||
    /^(?:ERR_NETWORK|ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|CLOUD_UNAVAILABLE|CLOUD_TIMEOUT)$/.test(error?.code||'')||
    /^(?:fetch failed|failed to fetch|network(?: request)? failed|load failed|offline)$/i.test(error?.message||'')));
function validate(data,query,offset){
  if(!data||data.schemaVersion!==1||!Array.isArray(data.items)||data.items.length>120||!['live','movie','series'].every(kind=>Number.isSafeInteger(data.counts?.[kind])&&data.counts[kind]>=0)||!Number.isSafeInteger(data.total)||data.total<0||typeof data.hasMore!=='boolean'||!data.revision||typeof data.revision!=='object'||normalizeSearchText(data.query)!==query||data.items.some(item=>!['live','movie','series'].includes(item?.kind)||!['string','number'].includes(typeof item.id))||new Set(data.items.map(item=>`${item.kind}:${item.id}`)).size!==data.items.length||data.hasMore&&(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<=offset||!data.items.length))throw new Error('SEARCH_RESPONSE_INVALID');
  return data;
}
function betterSnapshot(candidate,previous,type){
  if(previous.complete===true&&candidate.complete!==true)return false;
  if(candidate.complete===true&&previous.complete!==true)return true;
  const types=type==='all'?['live','movies','series']:[type];
  return types.some(type=>{
    const kind=type==='movies'?'movie':type;
    return candidate.counts[kind]>previous.counts[kind]||candidate.revision[type]?.complete===true&&
      (previous.partialTypes?.includes(type)||previous.missingTypes?.includes(type)||previous.revision[type]?.complete===false||!previous.revision[type]);
  });
}

/** Bounded, read-only search queries. Only an explicitly injected outage
 * fallback may inspect loaded snapshots; no reply crosses account/adult scope. */
export class RemoteSearch {
  constructor({request,getScope=()=>({}),loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),debounceMs=300,onChange=()=>{},prepare=value=>value,fallback=null}={}){
    Object.assign(this,{request,getScope,loadQueryCore,debounceMs,onChange,prepare,fallback});this.state=empty();this.epoch=0;this.scope=null;this.pending=null;this.timer=null;this.client=null;this.clientPromise=null;
  }
  emit(){this.onChange(this.state);}
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>{
      this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:30_000,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,networkMode:'always',structuralSharing:false}}});return this.client;
    }).catch(()=>null);return this.clientPromise;
  }
  cancel(){clearTimeout(this.timer);this.timer=null;this.epoch++;this.pending?.controller.abort();this.pending=null;void this.client?.cancelQueries();if(['queued','loading','more'].includes(this.state.phase))this.state={...this.state,phase:this.state.data?'ready':'idle'};}
  reset(){this.cancel();this.client?.clear();this.scope=null;this.state=empty();}
  search(input,{type='all',immediate=false,force=false}={}){
    const query=normalizeSearchText(input).slice(0,120),nextScope=scopeKey(this.getScope());type=TYPES.has(type)?type:'all';
    if(this.scope!==null&&this.scope!==nextScope)this.reset();this.scope=nextScope;
    const same=this.state.query===query&&this.state.type===type;
    this.cancel();this.state={query,type,phase:query?(canSearchGlobally(query)?'queued':'short'):'idle',data:same?this.state.data:null,error:null};this.emit();
    if(!canSearchGlobally(query))return Promise.resolve(null);
    if(immediate)return this.load({force});
    this.timer=setTimeout(()=>{this.timer=null;void this.load({force});},this.debounceMs);return Promise.resolve(null);
  }
  refresh(){return this.search(this.state.query,{type:this.state.type,immediate:true,force:true});}
  more(){if(this.pending||!this.state.data?.hasMore)return Promise.resolve(null);return this.load({offset:this.state.data.nextOffset??this.state.data.items.length});}
  async load({force=false,offset=0}={}){
    if(!canSearchGlobally(this.state.query)||this.pending)return null;
    const ticket={epoch:++this.epoch,scope:this.scope,query:this.state.query,type:this.state.type,controller:new AbortController()},previous=this.state.data;this.pending=ticket;
    const current=()=>this.pending===ticket&&this.epoch===ticket.epoch&&scopeKey(this.getScope())===ticket.scope&&!ticket.controller.signal.aborted;
    this.state={...this.state,phase:offset?'more':'loading',error:null};this.emit();
    try{
      const client=await this.queries();if(!current())throw abort();
      const queryKey=['arkhen-global-search',ticket.scope,ticket.query,ticket.type,offset,'remote'],scope=JSON.parse(ticket.scope);
      const input={query:ticket.query,type:ticket.type,offset,limit:120};
      const snapshot=async()=>{
        if(typeof this.fallback!=='function')return null;
        try{
          const value=await withRequestSignals([ticket.controller.signal],signal=>this.fallback(input,{signal}));
          if(!current())throw abort();if(!value)return null;
          validate(value,ticket.query,offset);
          const complete=value.complete===true&&value.partial!==true&&value.preparing!==true;
          return {...value,source:'client-snapshot',complete,partial:!complete,preparing:!complete,countsArePartial:value.countsArePartial??!complete};
        }catch(error){if(!current()||error?.name==='AbortError')throw abort();return null;}
      };
      const run=async({signal}={})=>{
        const data=await withRequestSignals([signal,ticket.controller.signal],signal=>this.request('/api/search',{method:'POST',body:JSON.stringify({...input,hidden:scope.hidden||{},hiddenItems:scope.hiddenItems||{}}),signal}));
        return validate(data,ticket.query,offset);
      };
      let response;
      try{response=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force?0:30_000}):await run();}
      catch(error){if(!current()||!transientRequest(error))throw error;response=await snapshot();if(!response)throw error;}
      if(!current())throw abort();
      if(localSource(response)&&response.source!=='client-snapshot'){
        const local=await snapshot();if(local&&betterSnapshot(local,response,ticket.type))response=local;
      }
      if(!current())throw abort();
      let data=this.prepare(response);
      if(offset){
        if(!previous||previous.source!==data.source||JSON.stringify(previous.revision)!==JSON.stringify(data.revision)||previous.total!==data.total)throw new Error('SEARCH_REVISION_CHANGED');
        const items=[...previous.items,...data.items],keys=new Set(items.map(item=>`${item.kind}:${item.id}`));if(keys.size!==items.length)throw new Error('SEARCH_DUPLICATE_PAGE');data={...data,items};
      }
      this.state={...this.state,data,phase:'ready',error:null};this.emit();
      const queries=client?.getQueryCache().getAll()||[];for(const query of queries.slice(0,Math.max(0,queries.length-20)))client.removeQueries({queryKey:query.queryKey,exact:true});
      return data;
    }catch(error){if(current()){this.state={...this.state,phase:'error',error:errorMessage(error)};this.emit();}return null;}
    finally{if(this.pending===ticket)this.pending=null;}
  }
}
