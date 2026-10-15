const types=['live','movies','series'];
const invalid=()=>Object.assign(new Error('Parâmetros de busca inválidos.'),{code:'SEARCH_INVALID_REQUEST',status:400});
export function normalizeCatalogSearch(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
function exclusions(value){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(type=>!types.includes(type)))throw invalid();
  const result={};
  for(const type of types){
    const ids=value[type];if(ids===undefined)continue;
    if(!Array.isArray(ids)||ids.length>2000||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)))throw invalid();
    result[type]=[...new Set(ids)];
  }return result;
}
export function catalogSearchRequest(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.query!=='string'||value.query.length>160)throw invalid();
  const query=normalizeCatalogSearch(value.query),type=value.type??'all',offset=value.offset??0,limit=value.limit??120;
  if(!['all',...types].includes(type)||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>120)throw invalid();
  return {query,type,offset,limit,hidden:exclusions(value.hidden),hiddenItems:exclusions(value.hiddenItems)};
}
export function shortCatalogSearch(query){return {schemaVersion:1,query,items:[],counts:{live:0,movie:0,series:0},total:0,hasMore:false,nextOffset:null,revision:{},complete:true,preparing:false,minimumLength:3};}
