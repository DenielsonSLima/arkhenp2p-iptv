import {sharedTVGuide} from '../tanstack-query.js';

/** One subscription to the existing EPG map, never a media preloader. */
export class TVPlayerPrograms{
  constructor({guide,request,getNamespace=()=>'',onUpdate}={}){
    Object.assign(this,{getNamespace,onUpdate});
    this.guide=guide||(typeof request==='function'?sharedTVGuide({request,getScope:()=>({account:String(getNamespace())||'session'})}):null);
    this.unsubscribe=null;this.namespace=null;
  }
  start(ids=null){
    const namespace=String(this.getNamespace());
    if(this.unsubscribe&&namespace===this.namespace){this.unsubscribe.updateIds?.(ids);return;}
    this.stop();this.namespace=namespace;
    this.unsubscribe=this.guide?.subscribe(()=>{
      if(this.namespace===String(this.getNamespace()))this.onUpdate?.();
    },{immediate:false,ids})||null;
  }
  peek(id){
    if(this.namespace!==String(this.getNamespace()))return null;
    return this.guide?.peek(id)||null;
  }
  status(){return this.guide?.state.loading?'loading':this.guide?.state.error?'error':'unavailable';}
  stop(){this.unsubscribe?.();this.unsubscribe=null;this.namespace=null;}
  destroy(){this.stop();}
}
