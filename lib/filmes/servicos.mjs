import {CatalogoFilmes} from './catalogo.mjs';
import {MetadadosFilmes} from './metadados.mjs';
import {movieRecommendationsRequest} from './recomendacoes-request.mjs';

/** Movie use cases, composed from metadata readers. Media play/Range, the
 * provider session and private library ownership remain shared dependencies. */
export class ServicosFilmes{
  constructor({cloudRuntime,catalogSearch}={}){
    this.cloudRuntime=cloudRuntime;this.catalogo=new CatalogoFilmes({cloudRuntime,catalogSearch});
    this.metadados=new MetadadosFilmes();
  }
  async recommendations(state,request,{signal,current=()=>true}={}){
    const input=movieRecommendationsRequest(request),started=performance.now();
    const check=()=>{if(signal?.aborted||!current())throw new DOMException('A consulta de recomendações foi cancelada.','AbortError');};check();
    let result;
    // The database owns ranking across the published generation. A transport
    // failure must not silently replace that result with a partial local rank.
    try{result=await this.cloudRuntime.movieRecommendations(state,input,{signal});}
    catch(error){
      check();
      // Expected transport/SQL failures are classified by the movie connector.
      // Preserve a code for an unexpected composition failure without logging
      // raw messages, request data, account identifiers or a library snapshot.
      console.warn('[movie-recommendations]',{phase:'service',code:'SERVICE_FAILED',elapsedMs:Math.max(0,Math.round(performance.now()-started)),
        ...(/^[A-Za-z0-9_]{1,80}$/.test(error?.code||'')?{transportCode:error.code}:{})});
    }
    check();
    if(result)state.parental?.rememberCatalog({categories:[],items:result.items},'movies');
    return result||null;
  }
}
