import {ServicosFilmes} from './servicos.mjs';
import {movieRecommendationsRequest} from './recomendacoes/request.mjs';

export const MOVIE_RECOMMENDATIONS_PATH='/api/recommendations/movie';
const cataloguePaths=new Set(['/api/catalog','/api/catalog/read-model']);
const movieID=value=>typeof value==='string'&&/^\d{1,12}$/.test(value);

/** Route composition after the shared authenticated-provider guard. Only the
 * movie slices of shared metadata endpoints are claimed; play/proxy/stop/status
 * and every series/live request stay with their existing handlers. */
export class OrquestradorFilmes{
  constructor({cloudRuntime,catalogSearch,respond,readInput,isClosed=()=>false}={}){
    Object.assign(this,{respond,readInput,isClosed});this.services=new ServicosFilmes({cloudRuntime,catalogSearch});
  }
  handles(url){return url.pathname===MOVIE_RECOMMENDATIONS_PATH||url.pathname==='/api/details'&&url.searchParams.get('type')==='movie'||cataloguePaths.has(url.pathname)&&url.searchParams.get('type')==='movies';}
  async handle(req,res,url,{state,client}){
    if(!this.handles(url))return false;
    const recommendations=url.pathname===MOVIE_RECOMMENDATIONS_PATH,details=url.pathname==='/api/details',model=url.pathname==='/api/catalog/read-model';
    const reply=(value,status=200)=>this.respond(res,value,status);
    if(recommendations?req.method!=='POST':model?req.method!=='GET':!['GET','HEAD'].includes(req.method)){reply({error:'Método inválido.'},405);return true;}
    const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);req.once('aborted',cancel);
    const generation=state.authGeneration,unlocked=state.parental?.unlocked===true;
    const current=()=>!this.isClosed()&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===unlocked&&!controller.signal.aborted&&!req.aborted&&!res.destroyed;
    const ended=()=>{
      if(controller.signal.aborted||req.aborted||res.destroyed)return true;
      if(this.isClosed()){reply({error:'Esta consulta de filmes foi encerrada.'},503);return true;}
      if(state.client!==client||state.authGeneration!==generation){reply({error:'Esta sessão foi encerrada.'},details?409:401);return true;}
      if((state.parental?.unlocked===true)!==unlocked){reply({error:'A proteção de conteúdo foi alterada.',...(recommendations?{code:'MOVIE_RECOMMENDATIONS_SCOPE_CHANGED'}:!details?{code:'CATALOG_SCOPE_CHANGED'}:{})},409);return true;}
      return false;
    };
    try{
      if(ended())return true;
      const options={signal:controller.signal,current};let result;
      if(recommendations){
        let input;try{input=movieRecommendationsRequest(await this.readInput(req,{maxBytes:65536}));}catch{if(!ended())reply({error:'Parâmetros de recomendações inválidos.',code:'MOVIE_RECOMMENDATIONS_INVALID_REQUEST'},400);return true;}
        if(ended())return true;
        result=await this.services.recommendations(state,input,options);if(ended())return true;
        if(!result)reply({error:'Não foi possível atualizar suas recomendações.',code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'},503);else reply(result);
      }else if(details){
        const id=url.searchParams.get('id');if(!movieID(id)){reply({error:'Identificador de filme inválido.'},400);return true;}
        result=await this.services.metadados.read(state,id,{...options,artworkOnly:url.searchParams.get('artwork')==='1',probeDuration:url.searchParams.get('duration')==='1'});if(ended())return true;
        if(!result)res.writeHead(404,{'Cache-Control':'no-store'}).end();else reply(result);
      }else if(model){
        result=await this.services.catalogo.readModel(state,options);if(ended())return true;
        if(!result)reply({error:'A organização do catálogo está sendo preparada.',code:'CATALOG_MODEL_PREPARING'},503);else reply(result);
      }else{
        result=await this.services.catalogo.load(state,url.searchParams,options);if(!ended())reply(result);
      }
      return true;
    }catch(error){if(ended())return true;throw error;}
    finally{res.off('close',cancel);req.off('aborted',cancel);}
  }
}
