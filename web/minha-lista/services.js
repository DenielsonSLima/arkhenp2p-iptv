import {selectLibraryFavorites} from '../library-selectors.js';

/** Read the existing account library. This module does not create another
 * Supabase identity, socket or private favourites cache. */
export class MyListServices{
  constructor({getSelection,resolveItem,isVisible=()=>true}={}){Object.assign(this,{getSelection,resolveItem,isVisible});}
  items(){return selectLibraryFavorites(this.getSelection()).map(item=>this.resolveItem(item)).filter(item=>item&&this.isVisible(item));}
}
