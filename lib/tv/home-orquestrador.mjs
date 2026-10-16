import {ConectorHomeTvSupabase} from './home-conector-supabase.mjs';
import {homeTvRequest,tvWatchRequest} from './home-request.mjs';

export const TV_HOME_API_PATHS=Object.freeze(['/api/tv/home','/api/tv/watch-heartbeat']);

/** TV-only private routes, mounted after the shared provider/account guard. */
export class OrquestradorHomeTv{
  constructor({cloudRuntime,respond,readInput,isClosed=()=>false}={}){Object.assign(this,{respond,readInput,isClosed});this.connector=new ConectorHomeTvSupabase({runtime:cloudRuntime});this.diagnostics=new WeakMap();}
  report(state,error,watch,started){
    const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value)?value:undefined;
    const entry={phase:error?.remoteCode?'rpc':'request',elapsedMs:Math.max(0,Date.now()-started),
      code:safe(error?.code)||'TV_HOME_UNAVAILABLE',...(safe(error?.remoteCode)?{remoteCode:safe(error.remoteCode)}:{}),
      ...(Number.isInteger(error?.remoteStatus)?{remoteStatus:error.remoteStatus}:{})};
    const key=JSON.stringify({...entry,elapsedMs:undefined}),previous=this.diagnostics.get(state),now=Date.now();
    if(previous?.key===key&&now-previous.at<30000)return;
    this.diagnostics.set(state,{key,at:now});console.warn(watch?'[tv-watch]':'[tv-home]',entry);
  }
  finish(state,client,options){
    const started=Date.now();
    return this.connector.finish(state,client,options).catch(error=>{this.report(state,error,true,started);return null;});
  }
  async handle(req,res,url,{state,client}){
    if(!TV_HOME_API_PATHS.includes(url.pathname))return false;
    const reply=(value,status=200)=>this.respond(res,value,status),watch=url.pathname==='/api/tv/watch-heartbeat',started=Date.now();
    if(req.method!=='POST'){reply({error:'Método inválido.'},405);return true;}
    const controller=new AbortController(),cancel=()=>controller.abort(),generation=state.authGeneration,pin=state.parental?.unlocked===true;
    res.once('close',cancel);req.once('aborted',cancel);
    const current=()=>!this.isClosed()&&!controller.signal.aborted&&!req.aborted&&!res.destroyed&&state.client===client&&state.authGeneration===generation&&(state.parental?.unlocked===true)===pin;
    try{
      const raw=await this.readInput(req,{maxBytes:65536}),input=watch?tvWatchRequest(raw):homeTvRequest(raw);
      if(!current())return true;
      const result=await this.connector[watch?'heartbeat':'read'](state,input,{signal:controller.signal,current});
      if(current())reply(result);
    }catch(error){
      if(!controller.signal.aborted&&!req.aborted&&!res.destroyed){
        const status=[400,401,403,409].includes(error?.status)?error.status:503;
        if(status===503)this.report(state,error,watch,started);
        reply({error:status===400?'Parâmetros de TV inválidos.':status===409?'Esta reprodução de TV foi encerrada.':'Não foi possível atualizar a seleção de canais agora.',
          code:status===400?'TV_HOME_INVALID_REQUEST':status===409?'TV_WATCH_INACTIVE':watch?'TV_WATCH_UNAVAILABLE':'TV_HOME_UNAVAILABLE'},status);
      }
    }finally{res.off('close',cancel);req.off('aborted',cancel);}
    return true;
  }
}
