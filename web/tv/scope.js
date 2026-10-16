/** A movie/series preference is not a TV scope change. Credentials and
 * progress are deliberately absent from all TV cache/request identities. */
export function tvScope(value){
  const account=value?.account||value?.libraryId;if(!account)return null;
  const live=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))].sort():[];
  return {account,project:value.project||value.url||'',providerKey:value.providerKey||'',scopeHash:value.scopeHash||'',
    epoch:value.epoch??0,includeAdult:value.includeAdult===true,
    hidden:live(Array.isArray(value.hidden)?value.hidden:value.hidden?.live),
    hiddenItems:live(Array.isArray(value.hiddenItems)?value.hiddenItems:value.hiddenItems?.live)};
}
export function tvScopeKey(value){const scope=tvScope(value);return scope?JSON.stringify(scope):null;}
