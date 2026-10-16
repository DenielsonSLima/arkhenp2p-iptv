import {tvScopeKey} from './scope.js';
const scopeKey=tvScopeKey;

/** Consume the application's authenticated socket events. This module does
 * not open another Realtime socket and never invalidates movie/series data. */
export class TVRealtime{
  constructor({guide,favorites,channels,getScope=()=>null}={}){
    Object.assign(this,{guide,favorites,channels,getScope});this.scope=null;this.revisions=new Map();
  }
  #synchronize(){const key=scopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;}
  sharedUpdated(event={}){
    if(!this.#synchronize())return false;
    const scope=this.getScope();if(event.providerKey&&event.providerKey!==scope.providerKey||event.scopeHash&&event.scopeHash!==scope.scopeHash)return false;
    if(event.table==='epg_cache_versions'){
      const revision=event.revision||null;if(revision&&this.revisions.get('epg')===revision)return false;
      if(revision)this.revisions.set('epg',revision);this.guide?.invalidate();return true;
    }
    if(['provider_catalog_cache','catalog_visible_generations'].includes(event.table)&&event.type==='live'){
      const revision=event.revision||null;if(revision&&this.revisions.get('catalog')===revision)return false;
      if(revision)this.revisions.set('catalog',revision);
      void this.channels?.invalidate({reload:true})?.catch?.(()=>{});return true;
    }
    return false;
  }
  libraryUpdated(snapshot,changes={}){
    if(!this.#synchronize())return false;
    if(changes.initial===true||(changes.favorites||[]).includes('live')){this.favorites?.reconcile(snapshot);return true;}
    return false;
  }
  reset(){this.scope=null;this.revisions.clear();}
  dispose(){this.reset();}
}
