import {seriesScope,seriesScopeKey} from './scope.js';

/** Consume already-validated events from the sole CloudLibrary connection.
 * Episode progress changes library projections, never catalogue or playback. */
export class SeriesRealtime{
  constructor({getScope=()=>null,queries,library,onCatalogRevision=()=>{},onFavoritesUpdate=()=>{},onProgressUpdate=()=>{}}={}){
    Object.assign(this,{getScope,queries,library,onCatalogRevision,onFavoritesUpdate,onProgressUpdate});this.scope=null;this.revision=null;
  }
  synchronize(){const key=seriesScopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;}
  sharedUpdated(event={}){
    if(!this.synchronize()||!['provider_catalog_cache','catalog_visible_generations'].includes(event.table)||event.type!=='series')return false;
    const scope=seriesScope(this.getScope());
    if(event.providerKey&&event.providerKey!==scope.providerKey||event.scopeHash&&event.scopeHash!==scope.scopeHash)return false;
    if(event.revision&&event.revision===this.revision)return false;
    const previous=Date.parse(this.revision),next=Date.parse(event.revision);
    if(Number.isFinite(previous)&&Number.isFinite(next)&&next<previous)return false;
    this.revision=event.revision||null;this.queries?.invalidate('details');this.onCatalogRevision(event);return true;
  }
  libraryUpdated(snapshot,changes={}){
    if(!this.synchronize())return false;
    snapshot=this.library?this.library.snapshot(snapshot):snapshot;
    if(!snapshot?.ready)return false;let affected=false;
    if(changes.initial||(changes.favorites||[]).includes('series')){this.queries?.invalidate('favorites');this.onFavoritesUpdate(snapshot);affected=true;}
    if(changes.initial||(changes.progress||[]).includes('series')){this.queries?.invalidate('progress');this.onProgressUpdate(snapshot);affected=true;}
    return affected;
  }
  reset(){this.scope=null;this.revision=null;}
}
