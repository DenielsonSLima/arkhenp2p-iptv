import {withRequestSignals} from '../request-signals.js';
import {tvScopeKey} from './scope.js';
import {normalizeGuideChannel,validateGuideProjection} from './canais/programacao.js';
import {TVProgramWindowCache} from './canais/cache-programacao.js';
export {normalizeGuideChannel} from './canais/programacao.js';

const emptyState=()=>({data:null,loading:false,error:null,stale:false});
const scopeKey=tvScopeKey;
const isChannelID=value=>/^\d{1,12}$/.test(String(value??''));
const abort=()=>new DOMException('Consulta da programação cancelada.','AbortError');
const bounded=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;

export const tvQueryKeys=Object.freeze({
  guide:(scope,ids=null)=>['arkhen-tv-guide',typeof scope==='string'?scope:tvScopeKey(scope),ids],
  favorites:scope=>['arkhen-tv','favorites',tvScopeKey(scope)],
  sources:(scope,id)=>['arkhen-tv','sources',tvScopeKey(scope),String(id)]
});

/** One bounded query for the union of channels needed by active consumers.
 * Cards, current channel and both neighbours join the same coalesced batch.
 * Source collection is a separate six-hour server job, not this timer. */
export class TVGuideClient{
  constructor({request,services=null,getScope=()=>null,loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),
    now=Date.now,document=globalThis.document,schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{request:services?.api||request,getScope,loadQueryCore,now,document,schedule,cancel});
    this.scope=null;this.epoch=0;this.invalidation=0;this.publication=0;this.pending=null;this.timer=null;this.freshUntil=0;this.failures=0;this.blocked=false;
    this.listeners=new Set();this.state=emptyState();this.client=null;this.clientPromise=null;this.disposed=false;
    this.selections=new Map();this.selectionKey='[]';this.selectionQueued=false;this.preparation=null;this.preparedScope=null;this.prewarmWanted=false;
    this.windows=new TVProgramWindowCache({now});
    this.onOnline=()=>{if(this.listeners.size&&!this.document?.hidden)this.invalidate();};
    this.onVisibility=()=>{if(this.document?.hidden){this.cancel(this.timer);this.timer=null;}else{if(this.prewarmWanted)void this.prewarm();if(this.listeners.size)void this.ensure();}};
    globalThis.addEventListener?.('online',this.onOnline);
    document?.addEventListener?.('visibilitychange',this.onVisibility);
  }
  emit(){for(const listener of [...this.listeners]){try{listener(this.state);}catch{}}}
  synchronizeScope(){
    const key=scopeKey(this.getScope());
    if(key!==this.scope){
      const prepareAgain=Boolean(this.preparedScope||this.preparation||this.prewarmWanted);
      this.clear();this.scope=key;this.prewarmWanted=Boolean(key&&prepareAgain);this.emit();
      // An attached cloud bootstrap or changed PIN/preferences can replace
      // the scope while existing cards remain mounted. Clearing the former
      // timer/request must also restart their shared reader in the new scope.
      if(key&&(this.listeners.size||this.prewarmWanted))queueMicrotask(()=>{
        // Query epochs can advance before this microtask when the selected
        // reader starts first; that must not suppress the new scope's warmup.
        if(!this.disposed&&this.scope===key&&scopeKey(this.getScope())===key){
          if(this.prewarmWanted)void this.prewarm();else if(this.listeners.size)void this.ensure();
        }
      });
    }
    return key;
  }
  clear(){
    this.epoch++;this.pending?.controller.abort();this.pending=null;
    this.cancel(this.timer);this.timer=null;this.freshUntil=0;this.failures=0;this.blocked=false;this.state=emptyState();
    this.windows.clear();this.preparedScope=null;this.prewarmWanted=false;
    void this.client?.cancelQueries();this.client?.clear();
  }
  reset(){this.clear();this.scope=null;this.emit();}
  requestedIds(){
    if(!this.selections.size)return null;
    const requested=new Set();
    for(const selection of this.selections.values()){
      // Omitted IDs preserve the full-map contract for external old callers.
      if(selection===null)return null;
      let ids;try{ids=typeof selection==='function'?selection():selection;}catch{ids=[];}
      for(const id of Array.isArray(ids)?ids:[])if(isChannelID(id))requested.add(String(id));
    }
    const ids=[...requested].sort();
    // Extreme selections use the existing full-map contract instead of
    // silently dropping the playing channel or exceeding HTTP header limits.
    return ids.length>2000||ids.join(',').length>6000?null:ids;
  }
  selectionChanged(){
    const key=JSON.stringify(this.requestedIds());if(key===this.selectionKey)return;
    this.selectionKey=key;this.invalidation++;this.freshUntil=0;this.blocked=false;
    // Mounting 48 cards in one render produces one request, not 48 requests.
    if(!this.selectionQueued&&this.listeners.size){this.selectionQueued=true;queueMicrotask(()=>{
      this.selectionQueued=false;if(!this.disposed&&this.listeners.size)void this.ensure();
    });}
  }
  subscribe(listener,{immediate=true,ids=null}={}){
    this.synchronizeScope();this.listeners.add(listener);this.selections.set(listener,ids);this.selectionChanged();
    if(immediate)listener(this.state);
    // Also resume a still-valid selection whose prior reader unsubscribed.
    queueMicrotask(()=>{if(this.listeners.has(listener))void this.ensure();});
    const unsubscribe=()=>{this.listeners.delete(listener);this.selections.delete(listener);this.selectionChanged();if(!this.listeners.size){this.cancel(this.timer);this.timer=null;}};
    unsubscribe.updateIds=(next=ids)=>{if(this.listeners.has(listener)){ids=next;this.selections.set(listener,next);this.selectionChanged();}};
    return unsubscribe;
  }
  peek(id){
    this.synchronizeScope();if(!isChannelID(id))return null;
    return this.windows.peek(id,{stale:this.state.stale});
  }
  prewarm(){
    const scope=this.synchronizeScope();
    if(this.disposed||!scope)return Promise.resolve(null);
    if(this.preparedScope===scope)return Promise.resolve(this.state.data);
    if(this.document?.hidden){this.prewarmWanted=true;return Promise.resolve(this.state.data);}
    if(this.preparation?.scope===scope)return this.preparation.promise;
    this.prewarmWanted=false;
    const ticket={scope,publication:this.publication,joinedSubset:Boolean(this.pending&&this.pending.ids!==null),promise:null};this.preparation=ticket;
    const unsubscribe=this.subscribe(()=>{},{immediate:false,ids:null});
    ticket.promise=(async()=>{
      let data=await this.ensure();
      // An earlier selected-ID request may already own the shared flight.
      // Keep the full-map consumer until its follow-up batch has completed.
      const publicationChanged=ticket.publication!==this.publication;
      if((ticket.joinedSubset||publicationChanged)&&scopeKey(this.getScope())===scope&&!this.disposed&&!this.state.error&&this.windows.freshUntil(null)<=this.now())data=await this.ensure({force:publicationChanged});
      if(scopeKey(this.getScope())!==scope)return null;
      if(this.windows.fullIds!==null)this.preparedScope=scope;
      return data;
    })().finally(()=>{unsubscribe();if(this.preparation===ticket)this.preparation=null;});
    return ticket.promise;
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
  scheduleRefresh(delay,{force=true}={}){
    this.cancel(this.timer);this.timer=null;
    if(this.disposed||!this.scope||!this.listeners.size||this.document?.hidden)return;
    this.timer=this.schedule(()=>{this.timer=null;void this.ensure({force});},delay);
  }
  invalidate(){
    this.invalidation++;this.publication++;this.freshUntil=0;this.blocked=false;
    this.windows.invalidate();
    void this.client?.invalidateQueries({queryKey:['arkhen-tv-guide'],refetchType:'none'});
    if(this.listeners.size&&!this.document?.hidden)void this.ensure({force:true});
  }
  ensure({force=false}={}){
    const scope=this.synchronizeScope();
    if(this.disposed||!scope||typeof this.request!=='function')return Promise.resolve(null);
    if(this.document?.hidden)return Promise.resolve(this.state.data);
    const ids=this.requestedIds();if(ids!==null&&!ids.length)return Promise.resolve(this.state.data);
    if(this.pending)return this.pending.promise;
    if(this.blocked&&!force)return Promise.resolve(null);
    const cachedUntil=this.windows.freshUntil(ids);
    if(!force&&this.now()<cachedUntil){
      this.scheduleRefresh(cachedUntil-this.now());return Promise.resolve(this.state.data);
    }
    if(!force&&this.state.error&&this.now()<this.freshUntil){this.scheduleRefresh(this.freshUntil-this.now());return Promise.resolve(this.state.data);}
    this.cancel(this.timer);this.timer=null;
    const ticket={epoch:++this.epoch,invalidation:this.invalidation,publication:this.publication,scope,ids,fresh:force,controller:new AbortController(),promise:null};this.pending=ticket;
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
      const params=new URLSearchParams();if(ticket.fresh)params.set('fresh','1');if(ticket.ids!==null)params.set('ids',ticket.ids.join(','));
      const run=({signal}={})=>withRequestSignals([signal,ticket.controller.signal],signal=>
        this.request('/api/tv/guide'+(params.size?'?'+params:''),{signal}).then(validateGuideProjection));
      const data=client?await client.fetchQuery({queryKey:tvQueryKeys.guide(ticket.scope,ticket.ids),queryFn:run,staleTime:0}):await run();
      if(!current())throw abort();
      const delay=this.refreshDelay(data);this.freshUntil=this.now()+delay;this.failures=0;
      this.windows.remember(data,{ids:ticket.ids,delay});
      // A publication invalidation is stronger than a changed selection. A
      // response started before it cannot certify fresh cached coverage.
      const invalidated=ticket.publication!==this.publication;if(invalidated)this.windows.invalidate();
      this.state={data,loading:false,error:null,stale:Boolean(data.stale||invalidated)};retryDelay=delay;
      return data;
    }catch(error){
      const owned=this.pending===ticket&&scopeKey(this.getScope())===ticket.scope&&this.epoch===ticket.epoch;
      if(owned){
        const denied=[401,403].includes(error?.status);
        this.blocked=denied;
        if(denied)this.windows.clear();
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
        this.emit();if(retryDelay!==null)this.scheduleRefresh(retryDelay,{force:ticket.publication!==this.publication||ticket.invalidation===this.invalidation});
      }
    }
  }
  dispose(){this.disposed=true;this.reset();this.listeners.clear();this.selections.clear();globalThis.removeEventListener?.('online',this.onOnline);this.document?.removeEventListener?.('visibilitychange',this.onVisibility);}
}

const clients=new WeakMap();
/** Compatibility construction still shares one client for one API function. */
export function sharedTVGuide({request,getScope}={}){
  if(typeof request!=='function')return null;
  if(!clients.has(request))clients.set(request,new TVGuideClient({request,getScope}));
  return clients.get(request);
}
