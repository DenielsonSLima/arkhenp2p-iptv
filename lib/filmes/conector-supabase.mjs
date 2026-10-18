import {ConectorRecomendacoesFilmesSupabase} from './recomendacoes/conector-supabase.mjs';

/** Stable movie-domain adapter. Catalog reads retain their shared snapshot
 * implementation; recommendations have an independent lifecycle and RPC. */
export class ConectorSupabaseFilmes{
  constructor({runtime}={}){this.runtime=runtime;this.closed=false;this.suggestions=new ConectorRecomendacoesFilmesSupabase({runtime});}
  snapshot(state,options){return this.closed||this.runtime.closed?Promise.resolve(null):this.runtime.catalog(state,'movies',options);}
  page(state,options){return this.closed||this.runtime.closed?Promise.resolve(null):this.runtime.catalogPage(state,'movies',options);}
  readModel(state,options){return this.closed||this.runtime.closed?Promise.resolve(null):this.runtime.catalogReadModel(state,'movies',options);}
  recommendations(state,request,options){return this.suggestions.recommendations(state,request,options);}
  close(){this.closed=true;this.suggestions.close();}
}
