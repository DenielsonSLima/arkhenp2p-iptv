/** A tab receives only its domain. Catalogue storage/coalescing remains in
 * the shared account repository, rather than another downloader per tab. */
export class CatalogTabServices{
  constructor(type,{loadCatalog,getCatalog}={}){this.type=type;this.loadCatalog=loadCatalog;this.getCatalog=getCatalog;}
  current(){return this.getCatalog?.(this.type)||null;}
  load({force=false,...options}={}){return Promise.resolve(this.loadCatalog?.(this.type,force,options));}
}
