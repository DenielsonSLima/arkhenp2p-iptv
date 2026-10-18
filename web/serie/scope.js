const selected=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))].sort():[];

/** Only series visibility changes this domain. Library positions, TV/movie
 * preferences and credentials are never part of metadata/cache identities. */
export function seriesScope(value){
  const account=value?.account||value?.libraryId;if(!account)return null;
  return {account,project:value.project||value.url||'',providerKey:value.providerKey||'',scopeHash:value.scopeHash||'',
    epoch:value.epoch??0,includeAdult:value.includeAdult===true,
    hidden:{series:selected(Array.isArray(value.hidden)?value.hidden:value.hidden?.series)},
    hiddenItems:{series:selected(Array.isArray(value.hiddenItems)?value.hiddenItems:value.hiddenItems?.series)}};
}
export function seriesScopeKey(value){const scope=seriesScope(value);return scope?JSON.stringify(scope):null;}
/** A cloud bootstrap can finish after the selected preview starts. The same
 * validated provider account must retain ownership of that detail request. */
export function seriesMetadataScopeKey(value){
  const scope=seriesScope(value);return scope?JSON.stringify({account:scope.account,epoch:scope.epoch,
    includeAdult:scope.includeAdult,hidden:scope.hidden,hiddenItems:scope.hiddenItems}):null;
}
export const seriesID=value=>value?.kind==='series'&&/^\d{1,12}$/.test(String(value.id??''))?String(value.id):null;
