import {CatalogFeature} from '../sistema/catalogo/aba.js';
import {SeriesServices} from './services.js';
import {SeriesSearch} from './busca.js';
import {SeriesQueries} from './tanstack-query.js';
import {SeriesRealtime} from './realtime.js';
import {SeriesSupabase} from './supabase.js';
import {renderSeriesPreview} from './previa.js';
import {seriesMetadata} from './titulo.js';

/** Series catalogue, selected metadata and typed search share the existing
 * repository, Auth, library, QueryClient and single application player. */
export class SeriesFeature extends CatalogFeature{
  constructor(options={}){super('series',options);}
  configure({request,getScope=()=>null,getQueryClient=()=>null,search,cloudLibrary,getSession,isVisible,canRemember,
    onCatalogRevision=()=>{},onFavoritesUpdate,onProgressUpdate}={}){
    if(this.queries)throw new Error('SERIES_ALREADY_CONFIGURED');
    this.getScope=getScope;this.services=this.services||new SeriesServices();this.services.configure({request,getScope});
    this.queries=new SeriesQueries({services:this.services,getScope,getQueryClient});
    this.searchController=new SeriesSearch({search,getScope});
    this.library=new SeriesSupabase({cloudLibrary,getSession,isVisible,canRemember});
    this.realtime=new SeriesRealtime({getScope,queries:this.queries,library:this.library,onFavoritesUpdate,onProgressUpdate,
      onCatalogRevision:event=>{this.genreIndex=null;onCatalogRevision(event);}});return this;
  }
  bindSearch(search){this.searchController?.bind(search);return this;}
  search(query,options){return this.searchController?.search(query,options)||Promise.resolve(null);}
  get searchState(){return this.searchController?.state||null;}
  details(item,options){return this.queries?.lookup(item,options)||Promise.reject(new Error('SERIES_NOT_CONFIGURED'));}
  peekDetails(item){return this.queries?.peek(item)||null;}
  invalidateDetails(){this.queries?.invalidate('details');}
  renderPreview(tools,item,options){return renderSeriesPreview(tools,item,options);}
  metadata(item){return seriesMetadata(item);}
  onLibraryChange(snapshot,changes){return this.realtime?.libraryUpdated(snapshot,changes)||false;}
  onSharedUpdate(event){return this.realtime?.sharedUpdated(event)||false;}
  reset(){super.reset();this.services?.reset?.();this.queries?.reset();this.searchController?.reset();this.realtime?.reset();}
  dispose(){this.reset();this.services?.dispose();}
}
