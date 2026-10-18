import {homeVODScope, homeVODScopeKey} from './scope.js';
import {withRequestSignals} from '../../request-signals.js';

const blank = () => ({data:null,loading:false,waiting:false,error:null});
const retryable = error => !error?.status || [408,425,429,500,502,503,504].includes(error.status);

/** Private, bounded home projections. Fetching belongs to the account, so it
 * can finish while another view is open. Revision refreshes preserve shelves;
 * account, visibility and parental changes cancel and discard them. */
export class HomeCloudModel {
  constructor({request,services=null,getScope,getRevision=()=>'',isActive=()=>true,isAvailable=()=>true,onChange=()=>{},loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),now=Date.now,minRefreshMs=15000,retryDelaysMs=[15000,30000,60000]}={}) {
    Object.assign(this,{request:services?.api||request,getScope,getRevision,isActive,isAvailable,onChange,loadQueryCore,now,minRefreshMs,retryDelaysMs});
    this.state=blank();this.epoch=0;this.scope=null;this.revision=null;
    this.lastLoadedAt=0;this.lastAttemptAt=null;this.retryAttempt=0;this.failureScope=null;this.blocked=false;
    this.retryDelaysMs=Array.isArray(retryDelaysMs)?retryDelaysMs.filter(delay=>Number.isFinite(delay)&&delay>=0).slice(0,3):[15000,30000,60000];
    this.pending=null;this.timer=null;this.client=null;this.clientPromise=null;this.disposed=false;
  }
  reset() {
    this.epoch++;clearTimeout(this.timer);this.timer=null;this.pending?.abort();this.pending=null;
    this.scope=null;this.revision=null;this.lastLoadedAt=0;this.lastAttemptAt=null;this.state=blank();
    // Resetting a view/preferences projection must not replenish a failed
    // connection's retry budget. ensure() releases it for a new scope or force.
    void this.client?.cancelQueries();this.client?.clear();
  }
  pause() {
    clearTimeout(this.timer);this.timer=null;this.epoch++;this.pending?.abort();this.pending=null;
    this.state={...this.state,loading:false};
  }
  async queries() {
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:30000,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,structuralSharing:false}}})).catch(()=>null);
    return this.clientPromise;
  }
  scheduleRefresh(delay) {
    if(this.disposed||this.blocked||this.timer!==null||!this.isActive())return;
    this.timer=setTimeout(()=>{this.timer=null;this.ensure();},Math.max(0,delay));
  }
  ensure({force=false}={}) {
    if(this.disposed)return;
    const scope=homeVODScope(this.getScope());
    if(!scope?.account){if(this.scope!==null)this.reset();return;}
    const scopeKey=JSON.stringify(scope),revision=JSON.stringify(this.getRevision());
    if(this.scope!==scopeKey){this.reset();this.scope=scopeKey;}
    if(this.failureScope!==scopeKey){this.failureScope=scopeKey;this.retryAttempt=0;this.blocked=false;}
    if(!this.isAvailable()){
      this.pause();
      if(!this.state.waiting){this.state={...this.state,waiting:true};this.onChange(this.state);}
      return;
    }
    if(this.state.waiting){this.state={...this.state,waiting:false};this.onChange(this.state);}
    // Keep the account snapshot while another screen/player is open, and
    // reconcile its latest revision on return instead of every progress tick.
    if(!this.isActive()){clearTimeout(this.timer);this.timer=null;return;}
    // A manual retry takes precedence over a refresh/backoff already queued.
    // Validated offline/connecting -> synced recovery also uses this explicit
    // force path; changing progress/catalog revisions never opens the circuit.
    if(force){clearTimeout(this.timer);this.timer=null;this.retryAttempt=0;this.blocked=false;}
    if(this.blocked)return;
    if(this.pending||this.timer!==null||!force&&!this.state.error&&this.revision===revision&&this.state.data)return;
    const wait=force||this.lastAttemptAt===null?0:Math.max(0,this.lastAttemptAt+this.minRefreshMs-this.now());
    if(wait){this.scheduleRefresh(wait);return;}
    void this.load(scope,scopeKey,revision,{force:force||Boolean(this.state.error)});
  }
  async load(scope,scopeKey,revision,{force=false}={}) {
    const epoch=++this.epoch,controller=new AbortController();this.pending=controller;
    this.state={...this.state,loading:true,waiting:false,error:null};this.onChange(this.state);
    const current=()=>!this.disposed&&this.epoch===epoch&&!controller.signal.aborted&&homeVODScopeKey(this.getScope())===scopeKey;
    let retryDelay=null,loaded=false;
    try {
      const client=await this.queries();if(!current())return;
      const queryKey=['arkhen-home-private',scopeKey,revision];
      const run=async({signal}={})=>{
        const value=await withRequestSignals([signal,controller.signal],combined=>this.request('/api/home/library',{method:'POST',body:JSON.stringify({hidden:scope.hidden||{},hiddenItems:scope.hiddenItems||{}}),signal:combined}));
        if(value?.schemaVersion!==1||!value.counts||!value.history||!Array.isArray(value.favoriteChannels)||!Array.isArray(value.recommendations?.items)||value.recommendations.items.length>30||value.favoriteChannels.length>30||['live','movie','series'].some(kind=>!Array.isArray(value.history[kind])||value.history[kind].length>30))throw new Error('HOME_RESPONSE_INVALID');
        return value;
      };
      const value=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force?0:30000}):await run();
      if(!current())return;
      this.revision=revision;this.lastLoadedAt=this.now();this.lastAttemptAt=this.lastLoadedAt;this.retryAttempt=0;this.blocked=false;loaded=true;
      this.state={data:value,loading:false,waiting:false,error:null};
      const entries=client?.getQueryCache().getAll()||[];
      for(const query of entries.slice(0,Math.max(0,entries.length-8)))client.removeQueries({queryKey:query.queryKey,exact:true});
    } catch(error) {
      if(current()){
        this.lastAttemptAt=this.now();this.state={...this.state,loading:false,error:'Não foi possível atualizar suas recomendações.'};
        if(retryable(error)&&this.retryAttempt<this.retryDelaysMs.length)retryDelay=this.retryDelaysMs[this.retryAttempt++];
        else this.blocked=true;
      }
    } finally {
      const owned=this.pending===controller;
      if(owned)this.pending=null;
      if(current()){
        // Recovery and changes received during a request do not depend on a
        // later home render, tab change or focus event to schedule their work.
        if(retryDelay!==null)this.scheduleRefresh(Math.max(this.minRefreshMs,retryDelay));
        else if(loaded&&JSON.stringify(this.getRevision())!==revision)this.ensure();
        this.onChange(this.state);
      }else if(owned&&this.epoch===epoch){
        // Losing cloud availability discards this reply, but must not leave
        // its loading indicator running after the request has finished.
        this.state={...this.state,loading:false};this.onChange(this.state);
      }
    }
  }
  dispose(){this.disposed=true;this.reset();this.client?.clear();}
}
