import {normalizeGuideChannel} from './programacao.js';
import {sharedTVGuide} from '../tanstack-query.js';

/** A selected-channel subscription into the shared map. Changing a channel
 * does not start another network request, timer or WPLAY consultation. */
export class LiveProgramFeed{
  constructor({request,onUpdate,getNamespace=()=>'',guide=null}={}){
    Object.assign(this,{request,onUpdate,getNamespace});
    this.guide=guide||sharedTVGuide({request,getScope:()=>({account:String(this.getNamespace())||'session'})});
    this.current=null;this.unsubscribe=null;
  }
  peek(id){return this.guide?.peek(id)||null;}
  start(id,{initialData}={}){
    this.stop();if(!/^\d{1,12}$/.test(String(id)))return;
    this.guide?.peek(id);
    const selection={id:String(id),namespace:String(this.getNamespace()),scope:this.guide?.scope};this.current=selection;
    const deliver=()=>{
      if(this.current!==selection||selection.namespace!==String(this.getNamespace()))return;
      const data=this.guide?.peek(selection.id)||(!this.guide?.state.data&&!this.guide?.state.error&&this.guide?.scope===selection.scope?normalizeGuideChannel(initialData):null)||
        {list:[],window:{previous:null,current:null,next:null},status:this.guide?.state.loading?'loading':this.guide?.state.error?'error':'unavailable',progressPercent:0};
      this.onUpdate?.(data);
    };
    if(this.guide)this.unsubscribe=this.guide.subscribe(deliver,{ids:[selection.id]});else deliver();
  }
  stop(){this.current=null;this.unsubscribe?.();this.unsubscribe=null;}
  destroy(){this.stop();}
}
