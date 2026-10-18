const selected=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))].sort():[];
/** Only VOD preferences affect the Home library; TV has its own projection. */
export function homeVODScope(value){
  const account=value?.account||value?.libraryId;if(!account)return null;
  return {account,project:value.project||value.url||'',providerKey:value.providerKey||'',scopeHash:value.scopeHash||'',
    epoch:value.epoch??0,includeAdult:value.includeAdult===true,
    hidden:Object.fromEntries(['movies','series'].map(type=>[type,selected(value.hidden?.[type])])),
    hiddenItems:Object.fromEntries(['movies','series'].map(type=>[type,selected(value.hiddenItems?.[type])]))};
}
export function homeVODScopeKey(value){const scope=homeVODScope(value);return scope?JSON.stringify(scope):null;}
