import {CatalogoSeries} from './catalogo.mjs';
import {MetadadosSeries} from './metadados.mjs';

const cataloguePaths=new Set(['/api/catalog','/api/catalog/read-model']);
const seriesID=value=>typeof value==='string'&&/^\d{1,12}$/.test(value);

/** Series slices of the existing authenticated metadata routes. Playback,
 * Range, stop/status, account session and the VOD kernel stay shared. */
export class OrquestradorSeries{
  constructor({cloudRuntime,catalogSearch,respond,isClosed=()=>false}={}){
    Object.assign(this,{respond,isClosed});
    this.services={catalogo:new CatalogoSeries({cloudRuntime,catalogSearch}),metadados:new MetadadosSeries()};
  }
  handles(url){return url.pathname==='/api/details'&&url.searchParams.get('type')==='series'||cataloguePaths.has(url.pathname)&&url.searchParams.get('type')==='series';}
  async handle(req,res,url,{state,client}){
    if(!this.handles(url))return false;
    const details=url.pathname==='/api/details',model=url.pathname==='/api/catalog/read-model';
    const reply=(value,status=200)=>this.respond(res,value,status);
    if(model?req.method!=='GET':!['GET','HEAD'].includes(req.method)){reply({error:'Método inválido.'},405);return true;}
    const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);req.once('aborted',cancel);
    const generation=state.authGeneration,unlocked=state.parental?.unlocked===true;
    const current=()=>!this.isClosed()&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===unlocked&&!controller.signal.aborted&&!req.aborted&&!res.destroyed;
    const ended=()=>{
      if(controller.signal.aborted||req.aborted||res.destroyed)return true;
      if(this.isClosed()){reply({error:'Esta consulta de séries foi encerrada.'},503);return true;}
      if(state.client!==client||state.authGeneration!==generation){reply({error:'Esta sessão foi encerrada.'},details?409:401);return true;}
      if((state.parental?.unlocked===true)!==unlocked){reply({error:'A proteção de conteúdo foi alterada.',...(!details?{code:'CATALOG_SCOPE_CHANGED'}:{})},409);return true;}
      return false;
    };
    try{
      if(ended())return true;
      const options={signal:controller.signal,current};let result;
      if(details){
        const id=url.searchParams.get('id');if(!seriesID(id)){reply({error:'Identificador de série inválido.'},400);return true;}
        result=await this.services.metadados.read(state,id,{...options,artworkOnly:url.searchParams.get('artwork')==='1'});if(ended())return true;
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
