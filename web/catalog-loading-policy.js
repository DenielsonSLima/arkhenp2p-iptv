import {isPagedCatalog} from './catalog-pagination.js';

// A cold central catalog is collected once by the server. Browsers may request
// visible pages, but must not duplicate that import in background completion.
export const isPreparingCatalog=(catalog,{cloudReady=false}={})=>Boolean(catalog?.preparing===true||cloudReady&&isPagedCatalog(catalog)&&catalog.pagination?.source!=='supabase');
export function completeCatalogForSession(pager,type,catalog,options){
  return isPreparingCatalog(catalog,options)?null:pager.complete(type);
}
