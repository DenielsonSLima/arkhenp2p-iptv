import {sharedTVGuide} from '../tanstack-query.js';

const channelID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;

/** Both neighbours subscribe to the same completed map as the current
 * channel and channel cards. A neighbouring slot never fetches its own ID. */
export class NeighborProgramFeeds{
  constructor({request,onUpdate,getNamespace=()=>'',guide=null}={}){
    Object.assign(this,{onUpdate,getNamespace});
    this.guide=guide||sharedTVGuide({request,getScope:()=>({account:String(this.getNamespace())||'session'})});
    this.selection={previous:null,next:null};this.namespace=null;this.unsubscribe=null;
  }
  select({previous=null,next=null}={}){
    const namespace=String(this.getNamespace()),selection={previous:channelID(previous),next:channelID(next)};
    if(namespace===this.namespace&&selection.previous===this.selection.previous&&selection.next===this.selection.next)return;
    this.stop();this.namespace=namespace;this.selection=selection;
    const emit=()=>{
      if(this.namespace!==String(this.getNamespace()))return;
      for(const [slot,id] of Object.entries(this.selection))if(id){
        const data=this.guide?.peek(id);
        this.onUpdate?.({...data,slot,id,list:data?.list||[],window:data?.window||{previous:null,current:null,next:null},
          status:data?.status||(this.guide?.state.loading?'loading':this.guide?.state.error?'error':'unavailable')});
      }
    };
    if(Object.values(selection).some(Boolean)&&this.guide)this.unsubscribe=this.guide.subscribe(emit,{ids:Object.values(selection).filter(Boolean)});else emit();
  }
  stop(){this.unsubscribe?.();this.unsubscribe=null;this.selection={previous:null,next:null};}
  destroy(){this.stop();this.namespace=null;}
}
