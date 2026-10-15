import {withRequestSignals} from './request-signals.js';
const blank=()=>({data:null,loading:false,error:null});
/** Private, bounded home projections. Revision changes preserve the current
 * shelves; account, visibility and parental changes cancel and discard them. */
export class HomeCloudModel{
  constructor({request,getScope,getRevision=()=>'',onChange=()=>{},loadQueryCore=()=>import('/assets/vendor/cloud-client.js'),now=Date.now,minRefreshMs=15000}={}){
    Object.assign(this,{request,getScope,getRevision,onChange,loadQueryCore,now,minRefreshMs});this.state=blank();this.epoch=0;this.scope=null;this.revision=null;this.lastLoadedAt=0;this.pending=null;this.timer=null;this.client=null;this.clientPromise=null;this.disposed=false;
  }
  reset(){this.epoch++;clearTimeout(this.timer);this.timer=null;this.pending?.abort();this.pending=null;this.scope=null;this.revision=null;this.lastLoadedAt=0;this.state=blank();void this.client?.cancelQueries();this.client?.clear();}
  pause(){clearTimeout(this.timer);this.timer=null;this.epoch++;this.pending?.abort();this.pending=null;this.state={...this.state,loading:false};}
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>this.client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:30000,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,structuralSharing:false}}})).catch(()=>null);
    return this.clientPromise;
  }
  ensure({force=false}={}){
    if(this.disposed)return;
    const scope=this.getScope();if(!scope?.account){if(this.scope!==null)this.reset();return;}
    const scopeKey=JSON.stringify(scope),revision=JSON.stringify(this.getRevision());
    if(this.scope!==scopeKey){this.reset();this.scope=scopeKey;}
    if(this.pending||this.timer||!force&&this.revision===revision&&this.state.data)return;
    const wait=force?0:Math.max(0,this.lastLoadedAt+this.minRefreshMs-this.now());
    if(wait){this.timer=setTimeout(()=>{this.timer=null;this.ensure();},wait);return;}
    void this.load(scope,scopeKey,revision,{force});
  }
  async load(scope,scopeKey,revision,{force=false}={}){
    const epoch=++this.epoch,controller=new AbortController();this.pending=controller;this.state={...this.state,loading:true,error:null};this.onChange(this.state);
    const current=()=>!this.disposed&&this.epoch===epoch&&!controller.signal.aborted&&JSON.stringify(this.getScope())===scopeKey;
    try{
      const client=await this.queries();if(!current())return;
      const queryKey=['arkhen-home-private',scopeKey,revision];
      const run=async({signal}={})=>{
        const value=await withRequestSignals([signal,controller.signal],combined=>this.request('/api/home/library',{method:'POST',body:JSON.stringify({hidden:scope.hidden||{},hiddenItems:scope.hiddenItems||{}}),signal:combined}));
        if(value?.schemaVersion!==1||!value.counts||!value.history||!Array.isArray(value.favoriteChannels)||!Array.isArray(value.recommendations?.items)||value.recommendations.items.length>30||value.favoriteChannels.length>30||['live','movie','series'].some(kind=>!Array.isArray(value.history[kind])||value.history[kind].length>30))throw new Error('HOME_RESPONSE_INVALID');
        return value;
      };
      const value=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force?0:30000}):await run();if(!current())return;
      this.revision=revision;this.lastLoadedAt=this.now();this.state={data:value,loading:false,error:null};
      const entries=client?.getQueryCache().getAll()||[];for(const query of entries.slice(0,Math.max(0,entries.length-8)))client.removeQueries({queryKey:query.queryKey,exact:true});
    }catch(error){if(current()){this.lastLoadedAt=this.now();this.state={...this.state,loading:false,error:'Não foi possível atualizar suas recomendações.'};}}
    finally{if(this.pending===controller)this.pending=null;if(current())this.onChange(this.state);}
  }
  dispose(){this.disposed=true;this.reset();this.client?.clear();}
}
