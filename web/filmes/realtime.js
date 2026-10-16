import {movieScope,movieScopeKey} from './scope.js';

/** Existing validated events only: no extra socket and no TV/series cache
 * invalidation. Playback progress reconciles the library without reloading
 * catalogue or issuing recommendation requests every five seconds. */
export class MoviesRealtime{
  constructor({getScope=()=>null,services,recommendations,favorites,progress,onCatalogRevision=()=>{}}={}){
    Object.assign(this,{getScope,services,recommendations,favorites,progress,onCatalogRevision});this.scope=null;this.revision=null;
  }
  #synchronize(){const key=movieScopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;}
  sharedUpdated(event={}){
    if(!this.#synchronize()||!['provider_catalog_cache','catalog_visible_generations'].includes(event.table)||event.type!=='movies')return false;
    const scope=movieScope(this.getScope());
    if(event.providerKey&&event.providerKey!==scope.providerKey||event.scopeHash&&event.scopeHash!==scope.scopeHash)return false;
    if(event.revision&&event.revision===this.revision)return false;
    this.revision=event.revision||null;this.services?.invalidate();this.recommendations?.invalidate();this.onCatalogRevision(event);return true;
  }
  libraryUpdated(snapshot,changes={}){
    if(!this.#synchronize()||!snapshot?.ready)return false;let affected=false;
    if(changes.initial||(changes.favorites||[]).includes('movie')){this.favorites?.reconcile(snapshot);affected=true;}
    if(changes.initial||(changes.progress||[]).includes('movie')){this.progress?.reconcile(snapshot);affected=true;}
    if(changes.initial||(changes.preferences||[]).some(key=>['catalog-settings','sort'].includes(key)))this.recommendations?.invalidate();
    return affected;
  }
  reset(){this.scope=null;this.revision=null;}
}
