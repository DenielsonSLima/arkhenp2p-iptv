import {selectLibraryFavorites,catalogCountLabel} from '../../library-selectors.js';

/** Each domain owns browsing state; rendering adapters consume this projection.
 * A shared implementation does not imply shared state or tasks. */
export class CatalogFeature{
  constructor(type,{sort='date',services=null}={}){this.type=type;this.initialSort=sort;this.services=services;this.reset();}
  load(options={}){return this.services?.load(options)||Promise.resolve(null);}
  reset(){this.browse={category:'__all',genre:'__all',sort:this.initialSort,limit:48,defaultPending:true,scrollY:0};this.genreIndex=null;}
  capture({category,genre,sort,limit,defaultPending,scrollY=0}){Object.assign(this.browse,{category,genre,sort,limit,defaultPending,scrollY});}
  restore(){return {...this.browse};}
  favorites(context){return selectLibraryFavorites({...context,type:this.type});}
  items(catalog,{favoritesOnly=false,...context}={}){return favoritesOnly?this.favorites(context):catalog?.items||[];}
  count(count,catalog,loading=false){return catalogCountLabel(count,{catalog,loading,kind:this.type==='live'?'canais':'títulos'});}
  libraryAffectsBrowse(changes){return changes.initial||changes.favorites.includes(this.type==='movies'?'movie':this.type)||changes.preferences.includes('catalog-settings')||changes.preferences.includes('sort')||changes.collections.some(type=>type===this.type||type==='all');}
}
