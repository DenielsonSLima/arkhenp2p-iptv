import {CatalogFeature} from '../sistema/catalogo/aba.js';
import {MoviesServices} from './services.js';
import {MovieRecommendationsModel} from './tanstack-query.js';
import {MoviesSupabase} from './supabase.js';
import {MoviesFavorites} from './favoritos.js';
import {MoviesProgress} from './progresso.js';
import {MoviesRealtime} from './realtime.js';
import {MovieSuggestionsView} from './recomendacoes/visualizacao.js';
import {renderMoviePreview} from './previa.js';
import {updateMovieDuration} from './duracao.js';

/** Movie browsing, metadata, library readers and suggestion destinations.
 * Shared video/Auth/provider sessions remain injected application owners. */
export class MoviesFeature extends CatalogFeature{
  constructor(options={}){super('movies',options);}
  configure({request,getScope=()=>null,getSession,cloudLibrary,recommendationsModel,getRevision=()=>'',
    getLocalFavorites,getLocalHistory,isVisible=()=>true,canRemember=()=>true,
    onLocalFavoriteChange,onLocalProgressChange,saveFavorite,saveProgress,onCatalogRevision=()=>{}}={}){
    if(this.library)throw new Error('MOVIES_ALREADY_CONFIGURED');
    this.getScope=getScope;this.services=this.services||new MoviesServices();this.services.configure({request,getScope});
    this.recommendations=recommendationsModel||new MovieRecommendationsModel({services:this.services,getScope,getRevision});
    if(recommendationsModel)this.recommendations.request=this.services.api;
    this.library=new MoviesSupabase({cloudLibrary,getSession,saveFavorite,saveProgress});
    const getQueryClient=()=>this.recommendations.client;
    this.favoritesStore=new MoviesFavorites({supabase:this.library,getScope,getLocalFavorites,onLocalChange:onLocalFavoriteChange,isVisible,getQueryClient});
    this.progress=new MoviesProgress({supabase:this.library,getScope,getLocalHistory,canRemember,onLocalChange:onLocalProgressChange,getQueryClient});
    this.realtime=new MoviesRealtime({getScope,services:this.services,recommendations:this.recommendations,favorites:this.favoritesStore,
      progress:this.progress,onCatalogRevision:event=>{this.genreIndex=null;onCatalogRevision(event);}});
    return this;
  }
  lookupSuggestions(item,options){return this.recommendations?.lookup(item,options)||Promise.reject(new Error('MOVIES_NOT_CONFIGURED'));}
  createSuggestions(options){
    if(this.suggestions)throw new Error('MOVIES_SUGGESTIONS_ALREADY_CREATED');
    return this.suggestions=new MovieSuggestionsView({...options,lookup:options?.lookup||((item,input)=>this.lookupSuggestions(item,input))});
  }
  renderPreview(tools,item,options={}){
    return renderMoviePreview(tools,item,{...options,relatedSection:options.relatedSection===undefined?this.suggestions?.previewFor(item):options.relatedSection});
  }
  updateDuration(tools,item,options){return updateMovieDuration(tools,item,options);}
  onLibraryChange(snapshot,changes){return this.realtime?.libraryUpdated(snapshot,changes)||false;}
  onSharedUpdate(event){return this.realtime?.sharedUpdated(event)||false;}
  onCloudStatus(status,previous){
    if(status?.state!=='synced'||!['connecting','offline','restricted','local'].includes(previous))return false;
    return this.suggestions?.recover()||false;
  }
  reset(){
    super.reset();this.services?.reset?.();this.recommendations?.reset();this.suggestions?.reset();
    this.favoritesStore?.reset();this.progress?.reset();this.library?.reset();this.realtime?.reset();
  }
  dispose(){this.reset();this.suggestions?.dispose();this.recommendations?.dispose();this.library?.dispose();this.services?.dispose();}
}
