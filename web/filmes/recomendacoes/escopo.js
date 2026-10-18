import {movieScope} from '../scope.js';

/** Suggestions inherit only movie filters and the account connection epoch.
 * A TV category/quality or series preference is not a movie destination change. */
export function movieSuggestionScope(value){
  const raw=value?.scope||value,scope=movieScope(raw);
  if(!scope)return value==null?null:typeof value==='object'?null:value;
  return {...scope,generation:value?.generation??scope.epoch};
}
export const movieSuggestionScopeKey=value=>JSON.stringify(movieSuggestionScope(value));

/** Cloud bootstrap may fill a previously absent binding for the same owner.
 * A different known provider/project/partition or connection is never retained. */
export function canRetainMovieSuggestions(previous,next){
  if(!previous||!next||typeof previous!=='object'||typeof next!=='object')return previous===next;
  const binding=['project','providerKey','scopeHash'];
  if(binding.some(key=>previous[key]&&next[key]&&previous[key]!==next[key]))return false;
  const owner=scope=>JSON.stringify({account:scope.account,epoch:scope.epoch,generation:scope.generation,
    includeAdult:scope.includeAdult,hidden:scope.hidden,hiddenItems:scope.hiddenItems});
  return owner(previous)===owner(next);
}
