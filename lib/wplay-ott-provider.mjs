import { createHash, randomUUID } from 'node:crypto';
import { ProviderClient, ProviderError, decodeText, safeID } from './provider.mjs';
import { validUpstreamURL, requestUpstream } from './upstream.mjs';
import { OttRPC } from './ott-rpc.mjs';
import { mediaDuration } from './media-duration.mjs';
import { probeMP4Duration } from './mp4-duration.mjs';

// Contracts observed in the public player.wplayott.com auth/watch bundles.
export const WPLAY_OTT_RPC=Object.freeze({
  login:'d29348f10d568118ba2943b39c2a8bb763efccdfb9e9cf161bc3e32c02a5ebc8',
  legacyLogin:'4fd67239cd8f98e4a56fdce95200165d00d519977b656594f281ce523e79c11e',
  catalog:'74cbf71759252bedc88527a8c9b97420241b41793d84f2d2b5ed2320e935fd6e',
  artwork:'b89f82879d11611b2fd5c708b368b370281ddd64d1db62206e2e8a3e9e03b45b',
  episodes:'dc7696faabd523b56d644e12b61f31a5214e08bbe0ce1e8cfd0d90b67b53cb11',
  logout:'e5b451824e40f5f5620db54332d181b41e8547490d3916bcbc1d88b9e7822d71'
});
const list=value=>Array.isArray(value)?value:[];
const kindOf=value=>({'Canal':'live','Filme':'movie','Série':'series'})[value];
const titleKind=kind=>({live:'Canal',movie:'Filme',series:'Série'})[kind];
const yearOf=value=>String(value??'').match(/\b(?:19|20)\d{2}\b/)?.[0]||'';
// The official watch bundle displays score as "% relevante" (0–100).
const ratingOf=value=>{const score=Number(value);return Number.isFinite(score)&&score>=0&&score<=100?score/10:0;};
const unavailableReply=result=>{
  const message=decodeText(result?.message).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return Number(result?.status)===503||/(?:servidor|server|servico|service|lista).{0,100}(?:indisponivel|unavailable|fora do ar)/.test(message);
};
const numericIdentity=value=>(BigInt('0x'+createHash('sha256').update(value).digest('hex').slice(0,16))%999999999999n+1n).toString();

export class WplayOTTProviderClient extends ProviderClient {
  constructor(config,{allowPrivate=false}={}) {
    const server=config?.server||'https://player.wplayott.com';
    const url=validUpstreamURL(server,allowPrivate);
    if(!allowPrivate&&url.origin!=='https://player.wplayott.com')throw new ProviderError('Servidor do player WPlay não reconhecido.','OTT_SERVER_INVALID',400);
    super({...config,server:url.origin},{allowPrivate});
    this.config.provider='wplay-ott';this.rpc=new OttRPC(url.origin,{allowPrivate});
    this.rawItems=new Map();this.identities=new Map();this.usedIDs=new Map();
    this.liveScreenSID=randomUUID();this.liveGeneration=0;this.liveSource=null;this.pendingRemoteStop=Promise.resolve();
    this.durationProbe=null;
  }
  identity(key) {
    if(this.identities.has(key))return this.identities.get(key);
    let id=numericIdentity(key),suffix=0;
    while(this.usedIDs.has(id)&&this.usedIDs.get(id)!==key)id=numericIdentity(key+':collision:'+(++suffix));
    this.identities.set(key,id);this.usedIDs.set(id,key);return id;
  }
  apiURL(){throw new ProviderError('Esta conta utiliza o player WPlay OTT.','OTT_OPERATION_INVALID',400);}
  async connect({signal}={}) {
    if(this.session)return this.session;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      let result=await this.rpc.call(WPLAY_OTT_RPC.login,{method:'POST',data:{identifier:this.config.username,password:this.config.password},signal});
      if(result?.authenticated===true){
        if(typeof result.accessToken!=='string'||!result.accessToken)throw new ProviderError('O player WPlay não retornou uma sessão válida.','OTT_SESSION_INVALID');
        this.rpc.accessToken=result.accessToken;this.refreshToken=result.refreshToken;this.member=true;
      } else {
        result=await this.rpc.call(WPLAY_OTT_RPC.legacyLogin,{method:'POST',data:{username:this.config.username,password:this.config.password},signal});
        if(result?.authenticated!==true&&unavailableReply(result))throw new ProviderError('O servidor da lista WPlay está indisponível no momento. Tente novamente em alguns minutos.','OTT_SERVICE_UNAVAILABLE',503);
        if(result?.authenticated!==true)throw new ProviderError('Usuário ou senha não foram aceitos pelo player WPlay.','AUTH_REJECTED',401);
        this.member=false;
      }
      this.authenticatedAt=Date.now();
      this.session={connected:true,account:{status:'Active',expiresAt:null,maxConnections:null,activeConnections:null,usernameMasked:'••••'+this.config.username.slice(-4),provider:'wplay-ott'}};
      return this.session;
    })();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  async api(action) {
    if(action)throw new ProviderError('Operação indisponível para esta conta WPlay OTT.','OTT_OPERATION_INVALID',400);
    await this.connect();return {user_info:{auth:1,status:'Active',exp_date:null,max_connections:null,active_cons:null}};
  }
  sourceURL(value) {
    if(typeof value!=='string'||!value)throw new ProviderError('O player WPlay não disponibilizou uma fonte para este conteúdo.','OTT_SOURCE_UNAVAILABLE',404);
    return validUpstreamURL(new URL(value,this.rpc.base).href,this.allowPrivate);
  }
  artwork(value){try{return value?this.image(this.sourceURL(value).href):'';}catch{return '';}}
  upstreamHeaders(value) {
    const url=new URL(value,this.rpc.base),headers={'User-Agent':'Mozilla/5.0'};
    if(url.origin===this.rpc.base.origin){const cookie=this.rpc.cookieHeader(url);if(cookie)headers.Cookie=cookie;if(this.rpc.accessToken)headers.Authorization='Bearer '+this.rpc.accessToken;headers.Referer=this.rpc.base.origin+'/watch';}
    return headers;
  }
  async rawCatalog({signal}={}) {
    await this.connect({signal});
    return this.memo('ott:catalog',async()=>{
      const payload=await this.rpc.call(WPLAY_OTT_RPC.catalog,{signal});
      if(!payload||!Array.isArray(payload.rows))throw new ProviderError('O player WPlay retornou um catálogo inválido.','OTT_INVALID_CATALOG');
      if(!payload.rows.some(row=>list(row?.items).length))throw new ProviderError('O serviço WPlay retornou um catálogo vazio. Tente novamente em alguns minutos.','OTT_EMPTY_CATALOG',503);
      return payload;
    });
  }
  async catalog(type,{signal}={}) {
    const desired={live:'live',movies:'movie',series:'series'}[type];
    if(!desired)throw new ProviderError('Tipo de catálogo inválido.','INVALID_CATALOG',400);
    return this.memo('catalog:'+type,async()=>{
      const payload=await this.rawCatalog({signal}),categories=new Map(),items=[],seen=new Set();
      for(const row of payload.rows){
        const categoryName=decodeText(row?.title)||'Outros',categoryId=this.identity('category:'+desired+':'+categoryName);
        for(const raw of list(row?.items)){
          const kind=kindOf(raw?.kind)||kindOf(row?.kind),name=decodeText(raw?.title);
          if(kind!==desired||!name||raw.id===undefined||raw.id===null)continue;
          const variants=kind==='live'&&list(raw.liveVariants).length?list(raw.liveVariants):[null];
          for(const variant of variants){
            const suffix=variant?String(variant.quality??''):'';
            const id=this.identity('item:'+kind+':'+String(raw.id)+(variant?':quality:'+suffix:''));if(seen.has(id))continue;
            const address=variant?.playbackUrl||raw.playbackUrl;
            const item={id,name:suffix?name+' '+decodeText(suffix):name,categoryId,poster:this.artwork(raw.image),backdrop:this.artwork(raw.backdrop),plot:decodeText(raw.description),year:yearOf(raw.year)||yearOf(raw.meta),rating:ratingOf(raw.score),kind,added:'',container:'mp4',...mediaDuration(kind==='live'?null:raw)};
            this.rawItems.set(kind+':'+id,{...raw,playbackUrl:address});seen.add(id);items.push(item);categories.set(categoryId,{id:categoryId,name:categoryName});
          }
        }
      }
      return {categories:[...categories.values()],items};
    });
  }
  invalidateCatalog(type){super.invalidateCatalog(type);this.cache.delete('ott:catalog');}
  async details(type,id,{probeDuration=false,signal}={}) {
    if(!['movie','series'].includes(type))throw new ProviderError('Tipo de mídia inválido.','INVALID_MEDIA',400);
    const item=await this.item(type==='movie'?'movies':'series',id),raw=this.rawItems.get(type+':'+item.id);
    const result=await this.memo(`details:${type}:${item.id}`,async()=>{
      // The official view treats optional artwork as best effort and keeps the
      // catalog episodes if their enrichment fails. Fetch both independently.
      const [artworkResult,episodesResult]=await Promise.all([
        this.rpc.call(WPLAY_OTT_RPC.artwork,{method:'POST',data:{title:raw.title,kind:titleKind(type)}}).catch(()=>null),
        type==='series'?this.rpc.call(WPLAY_OTT_RPC.episodes,{method:'POST',data:{title:raw.title}}).catch(()=>null):null
      ]);
      const artwork=artworkResult?.artwork||{};
      const result={...item,poster:this.artwork(artwork.image)||item.poster,backdrop:this.artwork(artwork.backdrop)||item.backdrop,plot:decodeText(artwork.description)||item.plot,year:yearOf(artwork.year)||item.year,rating:ratingOf(artwork.score)||item.rating,genre:list(raw.genres).map(decodeText).filter(Boolean).join(', '),...mediaDuration(artwork,raw),cast:list(raw.cast).map(decodeText).filter(Boolean).join(', '),director:'',seasons:[]};
      if(type==='series'){
        const episodes=list(episodesResult?.episodes).length?episodesResult.episodes:list(raw.episodes),seasons=new Map();
        for(const entry of episodes){
          const season=Number(entry?.season),number=Number(entry?.episode);
          if(!Number.isInteger(season)||season<0||!Number.isInteger(number)||number<0||entry.id===undefined)continue;
          const episodeId=this.identity('episode:'+item.id+':'+String(entry.id));
          const thumbnail=[entry.thumbnail,entry.still,entry.image,entry.poster,entry.cover].map(value=>this.artwork(value)).find(Boolean)||'';
          const episode={id:episodeId,title:decodeText(entry.title)||`Episódio ${number}`,number,season,...mediaDuration(entry),container:'mp4',...(thumbnail?{thumbnail}:{})};
          this.episodes.set(episodeId,{...episode,playbackUrl:entry.playbackUrl});
          if(!seasons.has(season))seasons.set(season,[]);seasons.get(season).push(episode);
        }
        result.seasons=[...seasons].sort(([a],[b])=>a-b).map(([number,episodes])=>({number,name:`Temporada ${number}`,episodes:episodes.sort((a,b)=>a.number-b.number)}));
      }
      return result;
    });
    const firstEpisode=type==='series'?result.seasons.find(season=>season.episodes.length)?.episodes[0]:null;
    if(probeDuration&&firstEpisode?.durationSeconds>0)return {...result,duration:firstEpisode.duration,durationSeconds:firstEpisode.durationSeconds,durationLabel:'1º episódio'};
    if(!probeDuration||result.durationSeconds>0)return result;
    const address=type==='series'?this.episodes.get(firstEpisode?.id)?.playbackUrl:raw.playbackUrl;
    let source;try{source=this.sourceURL(address);}catch{return result;}
    const seconds=await this.durationForSource(source,signal);
    if(seconds===null)return result;
    const metadata=mediaDuration({durationSeconds:seconds});
    // A probe enriches only this selected preview, never the shared hero/details
    // cache. For a series this is the first episode, not the series' total time.
    return {...result,...metadata,...(firstEpisode?{durationLabel:'1º episódio',seasons:result.seasons.map(season=>({...season,episodes:season.episodes.map(episode=>episode.id===firstEpisode.id?{...episode,...metadata}:episode)}))}:{})};
  }
  async durationForSource(source,signal) {
    if(this.playback||signal?.aborted)return null;
    const key='duration:'+source.href,discard=probe=>{
      if(probe?.controller.signal.aborted&&this.cache.get(probe.key)?.promise===probe.promise)this.cache.delete(probe.key);
    };
    // A reopened preview must not join a cancelled request that has not rejected
    // yet. Remove only that probe's memo entry, never a newer replacement.
    discard(this.durationProbe);let createdProbe;
    const promise=this.memo(key,async()=>{
      this.durationProbe?.controller.abort();
      discard(this.durationProbe);
      const probe={key,source:source.href,controller:new AbortController()};this.durationProbe=probe;createdProbe=probe;
      const cancel=()=>probe.controller.abort();signal?.addEventListener('abort',cancel,{once:true});
      try{
        const seconds=await probeMP4Duration(source,{headers:this.upstreamHeaders(source),allowPrivate:this.allowPrivate,signal:probe.controller.signal});
        if(seconds===null||probe.controller.signal.aborted)throw new Error('Duration unavailable.');
        return seconds;
      }finally{signal?.removeEventListener('abort',cancel);if(this.durationProbe===probe)this.durationProbe=null;}
    },24*60*60*1000);
    if(createdProbe)createdProbe.promise=promise;
    return promise.catch(()=>null);
  }
  async epg(id){await this.item('live',id);return {list:[]};}
  queueRemoteStop() {
    const previous=this.liveSource;this.liveSource=null;if(!previous)return this.pendingRemoteStop;
    this.pendingRemoteStop=this.pendingRemoteStop.catch(()=>{}).then(async()=>{
      const url=new URL(previous.url);url.searchParams.set('stop','1');url.searchParams.set('sid',this.liveScreenSID);url.searchParams.set('gen',String(previous.generation));
      const response=await requestUpstream(url,{method:'POST',headers:this.upstreamHeaders(url),allowPrivate:this.allowPrivate,timeout:6000,followRedirects:false});response.body.destroy();
    }).catch(()=>{});
    return this.pendingRemoteStop;
  }
  beginPlayback(key) {
    // playbackURL has already stopped the previous remote stream. Starting the
    // local transfer must not stop the newly selected sid/gen on the provider.
    this.durationProbe?.controller.abort();
    if(this.playback?.key!==key){
      this.playback?.controller.abort();this.playback={key,controller:new AbortController()};
      this.transfers=[];this.assets.clear();this.segmentCache.clear();this.segmentBytes=0;this.diagnosticLast=null;
    }
    return this.playback;
  }
  stopPlayback(){this.durationProbe?.controller.abort();super.stopPlayback();return this.queueRemoteStop();}
  async playbackURL(type,id) {
    id=safeID(id);let raw;
    if(type==='series'){raw=this.episodes.get(id);if(!raw)throw new ProviderError('Abra a série e escolha um episódio antes de reproduzir.','EPISODE_NOT_REGISTERED',400);}
    else if(['live','movie'].includes(type)){await this.item(type==='live'?'live':'movies',id);raw=this.rawItems.get(type+':'+id);}
    else throw new ProviderError('Tipo de mídia inválido.','INVALID_MEDIA',400);
    const source=this.sourceURL(raw.playbackUrl);
    if(type==='live'){
      const key='live:'+id;if(this.liveSource?.key!==key){await this.queueRemoteStop();this.liveSource={key,url:source.href,generation:++this.liveGeneration};}
      source.searchParams.set('sid',this.liveScreenSID);source.searchParams.set('gen',String(this.liveSource.generation));
    } else await this.queueRemoteStop();
    return source;
  }
  async logout(){await this.stopPlayback();try{await this.rpc.call(WPLAY_OTT_RPC.logout,{method:'POST'});}finally{this.rpc.cookieJar.clear();this.rpc.accessToken=null;this.refreshToken=null;this.session=null;}}
}
