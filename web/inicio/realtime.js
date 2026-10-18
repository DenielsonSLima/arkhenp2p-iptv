import {homeVODScopeKey as scopeKey} from './biblioteca/scope.js';

/** The validated application socket delivers events here. One microtask
 * batches changes after the caller has advanced its private revision. */
export class HomeRealtime{
  constructor({model,getScope=()=>null,invalidate=()=>{}}={}){
    Object.assign(this,{model,getScope,invalidate});this.epoch=0;this.pending=null;
  }
  #queue({force=false}={}){
    const scope=scopeKey(this.getScope());if(!scope)return false;
    this.invalidate();
    if(this.pending){this.pending.force ||= force;return true;}
    const ticket={epoch:this.epoch,scope,force};this.pending=ticket;
    queueMicrotask(()=>{
      if(this.pending!==ticket)return;this.pending=null;
      if(ticket.epoch===this.epoch&&ticket.scope===scopeKey(this.getScope()))this.model?.ensure({force:ticket.force});
    });return true;
  }
  libraryUpdated(snapshot,changes={}){
    if(!snapshot?.ready)return false;
    if(changes.initial||changes.favorites?.some(kind=>['movie','series'].includes(kind))||changes.progress?.some(kind=>['movie','series'].includes(kind))||changes.preferences?.some(key=>['catalog-settings','sort'].includes(key)))return this.#queue();
    return false;
  }
  sharedUpdated(event={}){
    return ['provider_catalog_cache','catalog_visible_generations'].includes(event.table)&&['movies','series'].includes(event.type)?this.#queue():false;
  }
  statusChanged(status,previous){
    return status?.state==='synced'&&['offline','connecting','restricted','local'].includes(previous)?this.#queue({force:true}):false;
  }
  reset(){this.epoch++;this.pending=null;}
  dispose(){this.reset();}
}
