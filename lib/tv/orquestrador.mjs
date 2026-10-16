import {playbackReader} from '../live-playback-session.mjs';
import {gamesRequestOptions,unavailableGames} from '../wplay-games.mjs';

export const TV_API_PATHS=Object.freeze(['/api/live/sources','/api/tv/guide','/api/epg','/api/games']);
const channelID=value=>typeof value==='string'&&/^\d{1,12}$/.test(value);
const unavailable={error:'A programação está temporariamente indisponível.',code:'TV_GUIDE_UNAVAILABLE'};

/** Authenticated TV metadata routes. The caller validates the provider before
 * dispatch; playback, stop, media proxy and VOD stay with the shared server. */
export class OrquestradorTv{
  constructor({cloudRuntime,respond,isClosed=()=>false}){Object.assign(this,{cloudRuntime,respond,isClosed});}
  async handle(req,res,url,{state,client}){
    if(!TV_API_PATHS.includes(url.pathname))return false;
    const reply=(value,status=200)=>this.respond(res,value,status);
    if(req.method!=='GET'){reply({error:'Método inválido.'},405);return true;}
    const generation=state.authGeneration,unlocked=state.parental.unlocked===true,reader=playbackReader(req,res);
    const ended=()=>{
      if(req.aborted||res.destroyed||reader.signal.aborted)return true;
      if(this.isClosed()){reply({error:'Esta consulta de TV foi encerrada.'},503);return true;}
      if(state.client!==client||state.authGeneration!==generation){reply({error:'Esta sessão foi encerrada.'},401);return true;}
      if((state.parental.unlocked===true)!==unlocked){reply({error:'A proteção de conteúdo foi alterada.'},409);return true;}
      return false;
    };
    try{
      if(ended())return true;
      if(url.pathname==='/api/live/sources'){
        const id=url.searchParams.get('id');if(!channelID(id)){reply({error:'Canal inválido.'},400);return true;}
        await state.parental.authorize(client,'live',id);if(ended())return true;
        const result=typeof client.liveSources==='function'?await client.liveSources(id,{signal:reader.signal}):{channelId:id,sources:[],selectedSourceId:null};
        if(!ended())reply(result);return true;
      }
      if(url.pathname==='/api/tv/guide'){
        const values=url.searchParams.get('ids'),ids=values?values.split(','):null;
        if(ids&&(ids.length>2000||ids.some(id=>!channelID(id)))){reply({error:'Lista de canais inválida.'},400);return true;}
        const result=await this.cloudRuntime.tvGuide(state,{ids,includeAdult:unlocked,fresh:url.searchParams.get('fresh')==='1'});
        if(ended())return true;
        if(!result)reply(unavailable,503);else reply(result);return true;
      }
      if(url.pathname==='/api/epg'){
        const id=url.searchParams.get('id');if(!channelID(id)){reply({error:'Canal inválido.'},400);return true;}
        await state.parental.authorize(client,'live',id);if(ended())return true;
        // Compatibility reads the same global projection as the TV page.
        // Recovery, when needed, captures one whole provider/scope guide in
        // the backend. Cards never request a separate provider channel guide.
        const guide=await this.cloudRuntime.tvGuide(state,{ids:[id],includeAdult:unlocked});
        if(ended())return true;
        const channel=guide?.channels?.[id];
        if(!Array.isArray(channel?.list)){reply(unavailable,503);return true;}
        reply({...channel,revision:guide.revision,projectionVersion:guide.projectionVersion,asOf:guide.asOf,
          stale:guide.stale===true,legacySnapshot:guide.legacySnapshot===true,...(guide.partial===true?{partial:true}:{})});return true;
      }
      const options=gamesRequestOptions({date:url.searchParams.get('date'),timeZone:url.searchParams.get('timezone')||url.searchParams.get('timeZone')||'UTC',lang:url.searchParams.get('lang')||'pt'});
      const shared=state.cloud?await this.cloudRuntime.games(state,options):null;if(ended())return true;
      const result=Array.isArray(shared?.games)?shared:typeof client.games==='function'
        ?await this.cloudRuntime.fallback(state,'games',[options.date,options.timeZone,options.lang],metadataClient=>metadataClient.games(options))
        :unavailableGames(options,'A agenda de jogos não está disponível neste tipo de conexão.');
      if(!ended())reply(result);return true;
    }catch(error){if(ended())return true;throw error;}
    finally{reader.dispose();}
  }
}
