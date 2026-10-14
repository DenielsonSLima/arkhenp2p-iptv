import { randomBytes } from 'node:crypto';
import { validUpstreamURL, requestUpstream, readBody } from './upstream.mjs';
import { MediaAssets } from './media-assets.mjs';

export class ProviderError extends Error {
  constructor(message,code,status=502){super(message);this.name='ProviderError';this.code=code;this.status=status;}
}
const rejectedAccess=()=>new ProviderError('Usuário ou senha não foram aceitos por este serviço. Confira os dados e, se sua conta for de outro serviço, ajuste o servidor em Opções de conexão.','AUTH_REJECTED',401);

export function decodeText(value) {
  return String(value ?? '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#(\d+)|#x([a-f\d]+));/gi,(match,decimal,hex)=>{
    if(decimal||hex){const code=parseInt(decimal||hex,hex?16:10);return code<=0x10ffff?String.fromCodePoint(code):'';}
    return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '})[match.toLowerCase()] || match;
  }).replace(/<[^>]*>/g,'').trim();
}
export function adultCategory(name) {return /\b(?:adulto?s?|adult|xxx|porn[oô]?|er[oó]tic[oa]s?)\b/i.test(decodeText(name));}
export function safeID(value) {const id=String(value??'');if(!/^\d{1,12}$/.test(id))throw new Error('Identificador de mídia inválido.');return id;}
export function connectionConfig(value, allowPrivate=false) {
  if(!value || typeof value.server!=='string' || typeof value.username!=='string' || typeof value.password!=='string')throw new Error('Informe servidor, usuário e senha.');
  const url=validUpstreamURL(value.server,allowPrivate);
  if(value.username.length>200 || value.password.length>200 || !value.username.trim() || !value.password)throw new Error('Usuário ou senha inválidos.');
  url.search='';url.hash='';url.pathname=url.pathname.replace(/\/(?:player_api|get)\.php$/,'').replace(/\/$/,'')+'/';
  return {server:url.href,username:value.username.trim(),password:value.password};
}
function dateISO(value) {const n=Number(value);return n>0 && Number.isFinite(n)?new Date(n*1000).toISOString():null;}
function yearOf(item) {const year=String(item.year || item.release_date || item.releaseDate || '').match(/(?:19|20)\d{2}/)?.[0];return year || decodeText(item.name).match(/\b(?:19|20)\d{2}\b/)?.[0] || '';}
function extension(value) {const ext=String(value||'mp4').toLowerCase();return /^[a-z0-9]{2,6}$/.test(ext)?ext:'mp4';}

export class ProviderClient {
  constructor(config, {allowPrivate=false}={}) {
    this.config=connectionConfig(config,allowPrivate);this.allowPrivate=allowPrivate;
    this.cache=new Map();this.images=new Map();this.assets=new MediaAssets();this.refs=new Map();this.episodes=new Map();this.session=null;this.authenticatedAt=0;this.playback=null;this.playbackGeneration=0;this.transfers=[];this.segmentCache=new Map();this.segmentBytes=0;
  }
  apiURL(action, params={}) {const url=new URL('player_api.php',this.config.server);url.searchParams.set('username',this.config.username);url.searchParams.set('password',this.config.password);if(action)url.searchParams.set('action',action);for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));return url;}
  async api(action,params={},options={}) {
    const response=await requestUpstream(this.apiURL(action,params),{allowPrivate:this.allowPrivate,timeout:options.timeout||45000,signal:options.signal});
    if(response.status!==200){response.body.destroy();if(!action&&[401,403].includes(response.status))throw rejectedAccess();throw new ProviderError(`O provedor retornou HTTP ${response.status}.`,'UPSTREAM_HTTP');}
    const buffer=await readBody(response);
    try{return JSON.parse(buffer.toString());}catch{throw new Error('O provedor não retornou uma resposta de catálogo válida.');}
  }
  async connect() {
    if(this.session && Date.now()-this.authenticatedAt<5*60*1000)return this.session;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const data=await this.api(undefined,{}, {timeout:8000});const info=data.user_info;
      if(!info || Number(info.auth)!==1)throw rejectedAccess();
      if(info.status && String(info.status).toLowerCase()!=='active')throw new ProviderError('A conta está inativa ou vencida no provedor.','ACCOUNT_INACTIVE',403);
      const expiresAt=dateISO(info.exp_date);
      if(expiresAt && Date.parse(expiresAt)<Date.now())throw new ProviderError('A assinatura venceu no provedor.','ACCOUNT_EXPIRED',403);
      this.session={connected:true,account:{status:info.status||'Active',expiresAt,maxConnections:Number(info.max_connections)||1,activeConnections:Number(info.active_cons)||0,usernameMasked:'••••'+this.config.username.slice(-4)}};
      this.authenticatedAt=Date.now();return this.session;
    })();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  memo(key,operation,ttl=15*60*1000) {
    const existing=this.cache.get(key);if(existing && Date.now()-existing.time<ttl)return existing.promise;
    const promise=operation();this.cache.set(key,{time:Date.now(),promise});promise.catch(()=>{if(this.cache.get(key)?.promise===promise)this.cache.delete(key);});return promise;
  }
  image(value) {
    if(!value || typeof value!=='string')return '';
    let url;try{url=validUpstreamURL(value,this.allowPrivate).href;}catch{return '';}
    if(!this.refs.has(url)){const token=randomBytes(18).toString('base64url');this.refs.set(url,token);this.images.set(token,url);}
    return '/api/image?ref='+this.refs.get(url);
  }
  async catalog(type) {
    const actions={live:['get_live_categories','get_live_streams','live'],movies:['get_vod_categories','get_vod_streams','movie'],series:['get_series_categories','get_series','series']};
    if(!actions[type])throw new Error('Tipo de catálogo inválido.');
    return this.memo('catalog:'+type,async()=>{
      const [categoryAction,itemAction,kind]=actions[type];const [rawCategories,rawItems]=await Promise.all([this.api(categoryAction),this.api(itemAction)]);
      if(!Array.isArray(rawCategories)||!Array.isArray(rawItems))throw new Error('O provedor retornou um catálogo incompleto.');
      const categories=rawCategories.map(c=>({id:String(c.category_id),name:decodeText(c.category_name)}));
      const allowed=new Set(categories.map(c=>c.id));
      const items=rawItems.filter(i=>allowed.has(String(i.category_id))).map(i=>({
        id:String(i.stream_id||i.series_id),name:decodeText(i.name),categoryId:String(i.category_id),poster:this.image(i.stream_icon||i.cover),year:yearOf(i),rating:Number(i.rating)||0,kind,added:String(i.added||i.last_modified||''),container:extension(i.container_extension),plot:decodeText(i.plot),backdrop:this.image(Array.isArray(i.backdrop_path)?i.backdrop_path[0]:i.backdrop_path)
      })).filter(i=>/^\d{1,12}$/.test(i.id));
      return {categories,items};
    });
  }
  invalidateCatalog(type) {
    if(!['live','movies','series'].includes(type))throw new Error('Tipo de catálogo inválido.');
    this.cache.delete('catalog:'+type);
    const prefix=type==='movies'?'details:movie:':type==='series'?'details:series:':'epg:';
    for(const key of this.cache.keys())if(key.startsWith(prefix))this.cache.delete(key);
  }
  async item(type,id) {id=safeID(id);const catalog=await this.catalog(type);const item=catalog.items.find(i=>i.id===id);if(!item)throw new Error('Mídia não disponível para esta conta.');return item;}
  async details(type,id) {
    const key=type==='movie'?'movies':type==='series'?'series':null;if(!key)throw new Error('Tipo de mídia inválido.');
    const item=await this.item(key,id);
    return this.memo(`details:${type}:${id}`,async()=>{
      const data=await this.api(type==='movie'?'get_vod_info':'get_series_info',type==='movie'?{vod_id:id}:{series_id:id});
      const info=data.info||{};const movie=data.movie_data||{};
      const backdrop=Array.isArray(info.backdrop_path)?info.backdrop_path[0]:info.backdrop_path;
      const result={id:item.id,name:decodeText(info.name||movie.name||item.name),poster:this.image(info.movie_image||info.cover)||item.poster,backdrop:this.image(backdrop)||item.backdrop,plot:decodeText(info.plot||info.description||item.plot),genre:decodeText(info.genre),year:yearOf(info)||item.year,rating:Number(info.rating)||item.rating,duration:info.duration||info.episode_run_time||'',cast:decodeText(info.cast||info.actors),director:decodeText(info.director),container:extension(movie.container_extension||item.container),source:{width:Number(info.video?.width)||null,height:Number(info.video?.height)||null,videoCodec:decodeText(info.video?.codec_name),audioCodec:decodeText(info.audio?.codec_name),audioChannels:Number(info.audio?.channels)||null},seasons:[]};
      if(type==='series') {
        for(const [number,entries]of Object.entries(data.episodes||{})) {
          if(!Array.isArray(entries))continue;
          const episodes=entries.filter(e=>/^\d{1,12}$/.test(String(e.id))).map(e=>{const episode={id:String(e.id),title:decodeText(e.title||`Episódio ${e.episode_num}`),number:Number(e.episode_num)||0,season:Number(e.season||number),duration:e.info?.duration||'',container:extension(e.container_extension)};this.episodes.set(episode.id,episode);return episode;}).sort((a,b)=>a.number-b.number);
          const seasonInfo=(data.seasons||[]).find(s=>Number(s.season_number)===Number(number));
          result.seasons.push({number:Number(number),name:decodeText(seasonInfo?.name||`Temporada ${number}`),episodes});
        }
        result.seasons.sort((a,b)=>a.number-b.number);
      }
      return result;
    });
  }
  async epg(id) {
    await this.item('live',id);
    return this.memo('epg:'+id,async()=>{
      const data=await this.api('get_short_epg',{stream_id:id,limit:6});
      const text=value=>{const string=String(value||'');return decodeText(/^[a-z0-9+/]+={0,2}$/i.test(string)&&string.length%4===0?Buffer.from(string,'base64').toString('utf8'):string);};
      return {list:(data.epg_listings||[]).map(e=>({title:text(e.title),description:text(e.description),start:dateISO(e.start_timestamp)||e.start,end:dateISO(e.stop_timestamp||e.end_timestamp)||e.end}))};
    },60000);
  }
  async playbackURL(type,id,container) {
    id=safeID(id);
    if(type==='live')await this.item('live',id);
    else if(type==='movie'){const item=await this.item('movies',id);container=item.container;}
    else if(type==='series'){const episode=this.episodes.get(id);if(!episode)throw new Error('Abra a série e escolha um episódio antes de reproduzir.');container=episode.container;}
    else throw new Error('Tipo de mídia inválido.');
    const ext=type==='live'?'m3u8':extension(container);
    return new URL(`${type}/${encodeURIComponent(this.config.username)}/${encodeURIComponent(this.config.password)}/${id}.${ext}`,this.config.server);
  }
  beginPlayback(key) {
    if(this.playback?.key!==key){this.playback?.controller.abort();this.playback={key,controller:new AbortController()};this.transfers=[];this.assets.clear();this.segmentCache.clear();this.segmentBytes=0;this.diagnosticLast=null;}
    return this.playback;
  }
  stopPlayback(){this.playbackGeneration++;this.playback?.controller.abort();this.playback=null;this.assets.clear();this.segmentCache.clear();this.segmentBytes=0;this.diagnosticLast=null;}
  recordTransfer(sample) {if(sample.key!==this.playback?.key)return;this.transfers.push({...sample,time:Date.now()});this.transfers=this.transfers.filter(s=>Date.now()-s.time<120000).slice(-120);}
  cachedSegment(url,key) {const sample=this.segmentCache.get(url);if(!sample||sample.key!==key||Date.now()-sample.time>60000)return null;return sample;}
  cacheSegment(url,key,buffer,type) {
    if(buffer.length>8*1024*1024||this.playback?.key!==key)return;
    const old=this.segmentCache.get(url);if(old)this.segmentBytes-=old.buffer.length;
    this.segmentCache.set(url,{key,buffer,type,time:Date.now()});this.segmentBytes+=buffer.length;
    while(this.segmentBytes>32*1024*1024){const first=this.segmentCache.keys().next().value;this.segmentBytes-=this.segmentCache.get(first).buffer.length;this.segmentCache.delete(first);}
  }
  asset(url,key,mediaDurationSeconds=null,cacheKey=null) {return this.assets.register(url,key,mediaDurationSeconds,cacheKey);}
  mediaURL(value){return validUpstreamURL(value,this.allowPrivate).href;}
  rewriteManifest(text,base,key) {
    let duration=null,sequence=null,discontinuity=0;
    const wrap=(uri,seconds=null)=>{const source=this.mediaURL(new URL(uri,base).href);const cacheKey=seconds&&sequence!==null?`${base}|${source}|${sequence}|${discontinuity}`:null;return this.asset(source,key,seconds,cacheKey);};
    return text.split(/\r?\n/).map(line=>{
      if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')){const value=Number(line.slice(22));sequence=Number.isSafeInteger(value)&&value>=0?value:null;}
      if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')){const value=Number(line.slice(30));discontinuity=Number.isSafeInteger(value)&&value>=0?value:0;}
      else if(line==='#EXT-X-DISCONTINUITY')discontinuity++;
      if(line.startsWith('#EXTINF:')){const value=Number(line.slice(8).split(',')[0]);duration=value>0?value:null;}
      if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${wrap(uri)}"`);
      if(!line.trim())return line;
      const local=wrap(line.trim(),duration);if(duration&&sequence!==null)sequence++;duration=null;return local;
    }).join('\n');
  }
}
