import {withoutSessionArtwork} from './stored-artwork.js';
import {artworkURL} from './channel-artwork.js';

/** A paginated catalog cannot decide that a private saved title disappeared. */
export function resolveLibraryItem(item,{catalog,libraryId,activeLibraryId}={}){
  if(!item||!libraryId||activeLibraryId!==libraryId||item.libraryId&&item.libraryId!==libraryId)return null;
  const current=catalog?.itemMap?.get(String(item.id));
  const saved=withoutSessionArtwork(item);
  if(current&&current.kind===item.kind&&String(current.id)===String(item.id)&&(!current.libraryId||current.libraryId===libraryId)){
    const resolved={...saved,...current,savedAt:item.savedAt,libraryId};
    // A sparse current row may add metadata without having artwork yet. Keep
    // the stable artwork already known for this exact account and title.
    for(const field of ['poster','posterOriginal','backdrop'])if(field in saved||field in current)resolved[field]=artworkURL(current[field])||saved[field]||'';
    return resolved;
  }
  return {...saved,id:String(item.id),libraryId,...(catalog?.catalogComplete===true?{catalogUnavailable:true}:{})};
}
