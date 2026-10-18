import {seriesScopeKey} from './scope.js';

const empty=()=>({query:'',type:'series',phase:'idle',data:null,error:null});

/** A typed destination of the application's one RemoteSearch. Its existing
 * RPC, TanStack cache, counts, pagination, order and cancellation stay intact. */
export class SeriesSearch{
  constructor({search,getScope=()=>null}={}){Object.assign(this,{engine:search,getScope});this.scope=null;}
  bind(search){if(this.engine!==search){this.reset();this.engine=search;}return this;}
  get state(){const scope=seriesScopeKey(this.getScope());return scope&&this.scope===scope&&this.engine?.state?.type==='series'?this.engine.state:empty();}
  search(query,{immediate=false,force=false}={}){
    const scope=seriesScopeKey(this.getScope());
    if(!scope||!this.engine)return Promise.resolve(null);
    if(this.scope!==null&&this.scope!==scope)this.reset();this.scope=scope;
    return this.engine.search(query,{type:'series',immediate,force});
  }
  refresh(){const state=this.state;return state.query?this.search(state.query,{immediate:true,force:true}):Promise.resolve(null);}
  more(){return this.state.phase!=='idle'?this.engine.more():Promise.resolve(null);}
  cancel(){if(this.scope!==null&&this.engine?.state?.type==='series')this.engine.cancel();}
  reset(){this.cancel();this.scope=null;}
}
