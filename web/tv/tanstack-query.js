import {withRequestSignals} from '../request-signals.js';
import {tvScopeKey} from './scope.js';
import {normalizeGuideChannel,validateGuideProjection} from './canais/programacao.js';
export {normalizeGuideChannel} from './canais/programacao.js';

const emptyState=()=>({data:null,loading:false,error:null,stale:false});
const scopeKey=tvScopeKey;
const isChannelID=value=>/^\d{1,12}$/.test(String(value??''));
const abort=()=>new DOMException('Consulta da programação cancelada.','AbortError');
const bounded=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;

export const tvQueryKeys=Object.freeze({
  guide:scope=>['arkhen-tv-guide',typeof scope==='string'?scope:tvScopeKey(scope)],
  favorites:scope=>['arkhen-tv','favorites',tvScopeKey(scope)],
  sources:(scope,id)=>['arkhen-tv','sources',tvScopeKey(scope),String(id)]
});

/** One bounded query for the eligible channel scope. Cards, current channel
 * and both neighbours consume this map; mounting a card never fetches an ID.
 * Source collection is a separate six-hour server job, not this timer. */
export class TVGuideClient{
  constructor({request,services=null,getScope=()=>null,loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),
    now=Date.now,schedule=(callback,delay)=>setTimeout(callback,delay),cancel=timer=>clearTimeout(timer)}={}){
    Object.assign(this,{request:services?.api||request,getScope,loadQueryCore,now,schedule,cancel});
    this.scope=null;this.epoch=0;this.invalidation=0;this.pending=null;this.timer=null;this.freshUntil=0;this.failures=0;this.blocked=false;
    this.listeners=new Set();this.state=emptyState();this.client=null;this.clientPromise=null;this.disposed=false;
    this.onOnline=()=>{if(this.listeners.size)this.invalidate();};
    globalThis.addEventListener?.('online',this.onOnline);
  }
  emit(){for(const listener of [...this.listeners]){try{listener(this.state);}catch{}}}
  synchronizeScope(){
    const key=scopeKey(this.getScope());
    if(key!==this.scope){
      this.clear();this.scope=key;this.emit();
      // An attached cloud bootstrap or changed PIN/preferences can replace
      // the scope while existing cards remain mounted. Clearing the former
      // timer/request must also restart their shared reader in the new scope.
      const epoch=this.epoch;
      if(key&&this.listeners.size)queueMicrotask(()=>{
        if(!this.disposed&&this.epoch===epoch&&this.scope===key&&scopeKey(this.getScope())===key&&this.listeners.size)void this.ensure();
      });
    }
    return key;
  }
  clear(){
    this.epoch++;this.pending?.controller.abort();this.pending=null;
    this.cancel(this.timer);this.timer=null;this.freshUntil=0;this.failures=0;this.blocked=false;this.state=emptyState();
    void this.client?.cancelQueries();this.client?.clear();
  }
  reset(){this.clear();this.scope=null;this.emit();}
  subscribe(listener,{immediate=true}={}){
    this.synchronizeScope();this.listeners.add(listener);if(immediate)listener(this.state);
    void this.ensure();
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.cancel(this.timer);this.timer=null;}};
  }
  peek(id){
    this.synchronizeScope();if(!isChannelID(id))return null;
    const data=this.state.data,channel=data?.channels[String(id)];
    return channel?{...channel,revision:data.revision,projectionVersion:data.projectionVersion,asOf:data.asOf,
      stale:Boolean(data.stale||this.state.stale),snapshotFetchedAt:data.snapshotFetchedAt}:null;
  }
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>{
      this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:0,gcTime:600_000,
        refetchOnWindowFocus:false,refetchOnReconnect:false,networkMode:'always',structuralSharing:false}}});return this.client;
    }).catch(()=>null);
    return this.clientPromise;
  }
  refreshDelay(data){
    // Relative server timestamps schedule another projection; no programme
    // selection or clock arithmetic is performed in the UI.
    const serverDelay=Date.parse(data.nextRefreshAt)-Date.parse(data.serverTime);
    return bounded(data.retryAfterMs??serverDelay,5000,300_000,60_000);
  }
  scheduleRefresh(delay){
    this.cancel(this.timer);this.timer=null;
    if(this.disposed||!this.scope||!this.listeners.size)return;
    this.timer=this.schedule(()=>{this.timer=null;void this.ensure({force:true});},delay);
  }
  invalidate(){
    this.invalidation++;this.freshUntil=0;this.blocked=false;
    void this.client?.invalidateQueries({queryKey:['arkhen-tv-guide'],refetchType:'none'});
    if(this.listeners.size)void this.ensure({force:true});
  }
  ensure({force=false}={}){
    const scope=this.synchronizeScope();
    if(this.disposed||!scope||typeof this.request!=='function')return Promise.resolve(null);
    if(this.pending)return this.pending.promise;
    if(this.blocked&&!force)return Promise.resolve(null);
    if(!force&&this.now()<this.freshUntil){
      this.scheduleRefresh(this.freshUntil-this.now());return Promise.resolve(this.state.data);
    }
    this.cancel(this.timer);this.timer=null;
    const ticket={epoch:++this.epoch,invalidation:this.invalidation,scope,fresh:force,controller:new AbortController(),promise:null};this.pending=ticket;
    this.state={...this.state,loading:true,error:null};ticket.promise=this.load(ticket);this.emit();
    return ticket.promise;
  }
  async load(ticket){
    const current=()=>!this.disposed&&this.pending===ticket&&this.epoch===ticket.epoch&&
      scopeKey(this.getScope())===ticket.scope&&!ticket.controller.signal.aborted;
    let retryDelay=null;
    const deadline=this.schedule(()=>ticket.controller.abort(),10_000);
    try{
      // Loading the SDK must not become another splash/guide gate. The first
      // request is still coalesced here if its cached module is unavailable.
      let queryDeadline;
      const client=await Promise.race([this.queries(),new Promise(resolve=>{queryDeadline=this.schedule(()=>resolve(null),500);})]);
      this.cancel(queryDeadline);if(!current())throw abort();
      const run=({signal}={})=>withRequestSignals([signal,ticket.controller.signal],signal=>
        this.request('/api/tv/guide'+(ticket.fresh?'?fresh=1':''),{signal}).then(validateGuideProjection));
      const data=client?await client.fetchQuery({queryKey:tvQueryKeys.guide(ticket.scope),queryFn:run,staleTime:0}):await run();
      if(!current())throw abort();
      const delay=this.refreshDelay(data);this.freshUntil=this.now()+delay;this.failures=0;
      this.state={data,loading:false,error:null,stale:Boolean(data.stale)};retryDelay=delay;
      return data;
    }catch(error){
      const owned=this.pending===ticket&&scopeKey(this.getScope())===ticket.scope&&this.epoch===ticket.epoch;
      if(owned){
        const denied=[401,403].includes(error?.status);
        this.blocked=denied;
        this.state={...this.state,data:denied?null:this.state.data,loading:false,error:'Não foi possível atualizar a programação.',stale:!denied&&Boolean(this.state.data)};
        if(!denied){retryDelay=bounded(error?.retryAfterMs,15_000,300_000,Math.min(300_000,15_000*2**Math.min(5,this.failures++)));this.freshUntil=this.now()+retryDelay;}
      }
      return null;
    }finally{
      this.cancel(deadline);
      if(this.pending===ticket){
        this.pending=null;
        const scope=scopeKey(this.getScope());
        if(scope!==ticket.scope){this.clear();this.scope=scope;retryDelay=scope?0:null;}
        else if(ticket.invalidation!==this.invalidation){this.freshUntil=0;retryDelay=0;}
        this.emit();if(retryDelay!==null)this.scheduleRefresh(retryDelay);
      }
    }
  }
  dispose(){this.disposed=true;this.reset();this.listeners.clear();globalThis.removeEventListener?.('online',this.onOnline);}
}

const clients=new WeakMap();
/** Compatibility construction still shares one client for one API function. */
export function sharedTVGuide({request,getScope}={}){
  if(typeof request!=='function')return null;
  if(!clients.has(request))clients.set(request,new TVGuideClient({request,getScope}));
  return clients.get(request);
}
