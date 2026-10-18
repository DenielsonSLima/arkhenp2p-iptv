import {playbackReader} from '../live-playback-session.mjs';
import {gamesRequestOptions,unavailableGames} from '../wplay/ao-vivo/jogos.mjs';

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
        const timings=[],record=(phase,started)=>{
          timings.push(`${phase};dur=${Math.max(0,performance.now()-started).toFixed(1)}`);
          if(!res.headersSent&&!res.destroyed)res.setHeader('Server-Timing',timings.join(', '));
        };
        // Source descriptors belong to the provider, not the personal cloud
        // library. Validate this account without waiting for Auth provisioning.
        let authorized=false;const providerStarted=performance.now();
        try{
          const session=['wplay','wplay-ott'].includes(client.libraryProvider)?client.session:await client.connect();if(ended())return true;
          const account=session?.account,expiry=account?.expiresAt,validated=Number(client.authenticatedAt),now=Date.now();
          authorized=Boolean(session?.connected&&String(account?.status||'').toLowerCase()==='active'
            &&(!expiry||Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)>now)
            &&(!['wplay','wplay-ott'].includes(client.libraryProvider)||Number.isFinite(validated)&&validated>0&&validated<=now+60000&&now-validated<=86400000));
          if(authorized){
            // Native TV already needs this account's catalogue for its sources.
            // Classify from that same authorized metadata, without a cloud RPC
            // or catalog()/connect() login refresh in the critical path.
            const loadCatalog=client.libraryProvider==='wplay'&&typeof client.liveSourceCatalog==='function'
              ?()=>client.liveSourceCatalog({current:()=>state.client===client&&state.authGeneration===generation})
              :undefined;
            await state.parental.authorize(client,'live',id,{loadCatalog});
          }
        }finally{record('provider',providerStarted);}
        if(ended())return true;
        if(!authorized){reply({error:'Valide novamente sua conta para continuar.',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'},401);return true;}
        let result;const sourcesStarted=performance.now();
        try{result=typeof client.liveSources==='function'?await client.liveSources(id,{signal:reader.signal,includeWeb:url.searchParams.get('all')==='1'}):{channelId:id,sources:[],selectedSourceId:null};}
        finally{record('sources',sourcesStarted);}
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
