import {withoutSessionArtwork} from './stored-artwork.js';

/** A paginated catalog cannot decide that a private saved title disappeared. */
export function resolveLibraryItem(item,{catalog,libraryId,activeLibraryId}={}){
  if(!item||!libraryId||activeLibraryId!==libraryId||item.libraryId&&item.libraryId!==libraryId)return null;
  const current=catalog?.itemMap?.get(String(item.id));
  if(current&&current.kind===item.kind)return {...item,...current,savedAt:item.savedAt,libraryId};
  return {...withoutSessionArtwork(item),id:String(item.id),libraryId,...(catalog?.catalogComplete===true?{catalogUnavailable:true}:{})};
}
