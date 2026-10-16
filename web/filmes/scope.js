const selected=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))].sort():[];

/** Series/TV preferences and private playback positions do not change a
 * movie metadata reader. Account, generation and parental changes do. */
export function movieScope(value){
  const account=value?.account||value?.libraryId;if(!account)return null;
  return {account,project:value.project||value.url||'',providerKey:value.providerKey||'',scopeHash:value.scopeHash||'',
    epoch:value.epoch??0,includeAdult:value.includeAdult===true,
    hidden:{movies:selected(Array.isArray(value.hidden)?value.hidden:value.hidden?.movies)},
    hiddenItems:{movies:selected(Array.isArray(value.hiddenItems)?value.hiddenItems:value.hiddenItems?.movies)}};
}
export function movieScopeKey(value){const scope=movieScope(value);return scope?JSON.stringify(scope):null;}
export const movieID=value=>value?.kind==='movie'&&/^\d{1,12}$/.test(String(value.id??''))?String(value.id):null;
