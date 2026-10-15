import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { ProviderClient, ProviderError } from './provider.mjs';
import { WplayOTTProviderClient } from './wplay-ott-provider.mjs';
import { WplayPlaybackProviderClient } from './wplay-playback.mjs';
import { WPLAY_AUTH_URLS } from './wplay-provider.mjs';
import { configuredNativeBridge } from './bridge-configuration.mjs';
import { requestUpstream, readBody } from './upstream.mjs';
import { analyzeConnection } from './diagnostics.mjs';
import { gamesRequestOptions, unavailableGames } from './wplay-games.mjs';
import { accountLibrarySession } from './account-library.mjs';
import { CloudRuntime } from './cloud-runtime.mjs';
import { ARKHEN_SUPABASE_PROJECT } from './supabase-cloud.mjs';
import { readSportsLogo } from './sports-logo-cache.mjs';

// Compare requested files to the same canonical filesystem spelling (macOS
// may return NFD paths even when the module was imported through an NFC URL).
// The trailing separator keeps similarly named sibling directories outside.
const root=(await realpath(fileURLToPath(new URL('../web/',import.meta.url))))+path.sep;
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.jpg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.woff':'font/woff','.txt':'text/plain; charset=utf-8','.m3u':'audio/x-mpegurl'};
export function parseRange(range,size) {
  const match=/^bytes=(\d*)-(\d*)$/.exec(range||'');
  if(!match||(!match[1]&&!match[2])||size<=0)return null;
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||start>end)return null;
  return {start,end:Math.min(end,size-1)};
}
async function configuredConnection() {
  if(process.env.IPTV_SERVER&&process.env.IPTV_USERNAME&&process.env.IPTV_PASSWORD)return {server:process.env.IPTV_SERVER,username:process.env.IPTV_USERNAME,password:process.env.IPTV_PASSWORD};
  try{return JSON.parse(await readFile(new URL('../.local/connection.json',import.meta.url),'utf8'));}catch{return null;}
}
function json(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function input(req) {const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw new Error('Dados de conexão excederam o tamanho permitido.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new Error('Dados de conexão inválidos.');}}

export function createApp({connection,allowPrivateUpstream=false,nativeBridge,environment=process.env,cloud=null,sharedWorker,providerFactory,sportsLogoReader=readSportsLogo,onPlaybackError}={}) {
  const configuration=connection?Promise.resolve(connection):configuredConnection();
  const bridge=nativeBridge!==undefined?Promise.resolve(nativeBridge):configuredNativeBridge({env:environment});
  const sessions=new Map();const images=new Map();const imageNamespaces=new WeakMap();let imageBytes=0,shuttingDown=false;
  const cloudRuntime=new CloudRuntime({cloud,worker:sharedWorker});
  const capabilities=()=>({games:true,accountLibrary:true,cloud:cloudRuntime.enabled});
  const playbackError=({kind,code,status=502,upstreamStatus=null})=>{
    if(typeof onPlaybackError!=='function'||!['live','movie','series'].includes(kind))return;
    const validStatus=value=>Number.isInteger(value)&&value>=100&&value<=599;
    const event=Object.freeze({kind,code:typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'CONNECTION_FAILED',status:validStatus(status)?status:502,upstreamStatus:validStatus(upstreamStatus)?upstreamStatus:null});
    try{onPlaybackError(event);}catch{/* Diagnostics cannot interrupt playback or its error response. */}
  };
  const releaseClient=async client=>{try{if(client?.logout)await client.logout();else await client?.stopPlayback();}catch{/* cleanup must not create an unhandled rejection */}};
  function browserSession(req,res) {
    const token=req.headers.cookie?.match(/(?:^|;\s*)ORBIT_SID=([\w-]+)/)?.[1];
    if(token&&sessions.has(token)){const existing=sessions.get(token);existing.seen=Date.now();return existing;}
    const next=randomBytes(24).toString('base64url');const state={client:null,loggedOut:false,authGeneration:0,seen:Date.now(),attempts:[]};sessions.set(next,state);
    res.setHeader('Set-Cookie',`ORBIT_SID=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    if(sessions.size>64){for(const [id,item]of sessions)if(Date.now()-item.seen>24*60*60*1000){sessions.delete(id);cloudRuntime.detach(item);void releaseClient(item.client);}}
    return state;
  }
  function friendly(error,client) {
    let message=error instanceof Error?error.message:'Não foi possível concluir a operação.';
    for(const value of [client?.config.username,client?.config.password])if(value)message=message.split(value).join('••••');
    if(/getaddrinfo|ECONN|socket|certificate|ENOTFOUND|AbortError|aborted/i.test(message))return 'Não foi possível conectar ao provedor. Verifique o servidor e tente novamente.';
    return message.slice(0,240);
  }
  async function api(req,res,url) {
    const state=browserSession(req,res);
    if(url.pathname==='/api/session') {
      if(req.method!=='GET'){json(res,{error:'Método inválido.'},405);return;}
      const config=await configuration;
      const login={configuredServer:typeof config?.server==='string'&&Boolean(config.server),defaultProvider:'wplay'};
      const client=state.client,generation=state.authGeneration;
      try{
        const session=client?accountLibrarySession(await client.connect(),client.config,client.libraryProvider):{connected:false};
        if(client&&state.client===client&&state.authGeneration===generation)await cloudRuntime.attach(state,session,client,generation);
        const current=state.client===client&&state.authGeneration===generation;
        json(res,{...(current?session:{connected:false}),capabilities:capabilities(),login,...(current?cloudRuntime.fields(state):{cloud:null,cloudStatus:{state:'disabled'}})});
      }catch(error){const current=state.client===client&&state.authGeneration===generation;if(current)cloudRuntime.detach(state);json(res,{connected:false,error:friendly(error,client),capabilities:capabilities(),login,...(current?cloudRuntime.fields(state):{cloud:null,cloudStatus:{state:'disabled'}})});}
      return;
    }
    if(url.pathname==='/api/login') {
      if(req.method!=='POST'){json(res,{error:'Método inválido.'},405);return;}
      state.attempts=state.attempts.filter(t=>Date.now()-t<60000);
      if(state.attempts.length>=8){json(res,{error:'Aguarde um minuto antes de tentar novamente.'},429);return;}
      state.attempts.push(Date.now());const generation=++state.authGeneration;const value=await input(req);
      if(typeof value.username!=='string'||!value.username.trim()||typeof value.password!=='string'||!value.password){json(res,{connected:false,error:'Informe seu usuário e sua senha.'},400);return;}
      const config=await configuration;
      const provider=value.provider||'wplay';
      if(!['wplay','wplay-ott','xtream'].includes(provider)){json(res,{connected:false,error:'Tipo de acesso não reconhecido.'},400);return;}
      const server=provider==='wplay'?WPLAY_AUTH_URLS[1]:provider==='wplay-ott'?'https://player.wplayott.com':typeof value.server==='string'&&value.server.trim()?value.server.trim():config?.server;
      if(!server){json(res,{connected:false,error:'Abra as opções de conexão e informe o servidor do seu serviço IPTV.'},400);return;}
      let client;
      try{const clientConfig={server,username:value.username,password:value.password,...(provider==='wplay'?{authURLs:[WPLAY_AUTH_URLS[1],WPLAY_AUTH_URLS[0]]}:{})},clientOptions={allowPrivate:allowPrivateUpstream,bridge:provider==='wplay'?await bridge:null};
        client=providerFactory?await providerFactory({provider,config:clientConfig,options:clientOptions}):new (provider==='wplay'?WplayPlaybackProviderClient:provider==='wplay-ott'?WplayOTTProviderClient:ProviderClient)(clientConfig,clientOptions);}
      catch(error){json(res,{connected:false,error:friendly(error),code:'INVALID_CONNECTION'},400);return;}
      try{
        const session=await client.connect();
        if(generation!==state.authGeneration){await releaseClient(client);json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada. Entre novamente para continuar.',code:'LOGIN_CANCELLED'},409);return;}
        cloudRuntime.detach(state);if(state.client?.logout)await state.client.logout();else await state.client?.stopPlayback();
        if(generation!==state.authGeneration){await client.logout?.();json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada.',code:'LOGIN_CANCELLED'},409);return;}
        client.libraryProvider=provider;state.client=client;state.loggedOut=false;state.attempts=[];
        const connected=accountLibrarySession(session,client.config,provider);await cloudRuntime.attach(state,connected,client,generation);
        if(generation!==state.authGeneration||state.client!==client){json(res,{connected:false,error:'Esta tentativa de entrada foi cancelada.',code:'LOGIN_CANCELLED'},409);return;}
        json(res,{...connected,capabilities:capabilities(),...cloudRuntime.fields(state)});
      }catch(error){json(res,{connected:false,error:friendly(error,client),code:error instanceof ProviderError?error.code:'CONNECTION_FAILED'},error instanceof ProviderError&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502);}
      return;
    }
    if(url.pathname==='/api/logout'||url.pathname==='/api/stop') {
      if(req.method!=='POST'){json(res,{error:'Método inválido.'},405);return;}
      const previous=state.client;
      if(url.pathname==='/api/logout'){
        state.authGeneration++;cloudRuntime.detach(state,previous);state.client=null;state.loggedOut=true;
        // The local session is already closed. A provider outage must not make
        // the browser treat that logout as a failed operation.
        try{if(previous?.logout)await previous.logout();else await previous?.stopPlayback();}catch{}
      }else await previous?.stopPlayback();
      json(res,{connected:!!state.client});return;
    }
    const client=state.client;
    if(!client?.session){json(res,{error:'Conecte a conta para carregar o catálogo.'},401);return;}
    if(!['GET','HEAD'].includes(req.method)){json(res,{error:'Método inválido.'},405);return;}
    if(cloudRuntime.enabled&&['wplay','wplay-ott'].includes(client.libraryProvider)&&(['/api/catalog','/api/epg','/api/games'].includes(url.pathname)||/^\/api\/(?:shared|sports)-image\//.test(url.pathname))){
      const generation=state.authGeneration;let verified;
      try{verified=accountLibrarySession(await client.connect(),client.config,client.libraryProvider);}
      catch(error){
        if(state.client===client&&state.authGeneration===generation){
          if([401,403].includes(error?.status))await cloudRuntime.attach(state,{connected:false,account:{...client.session?.account,libraryId:state.cloud?.libraryId,status:'Disabled'}},client,generation);
          else cloudRuntime.detach(state,client);
        }
        throw error;
      }
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      await cloudRuntime.attach(state,verified,client,generation);
      if(state.client!==client||state.authGeneration!==generation){json(res,{error:'Esta sessão foi encerrada.'},401);return;}
      const account=verified.account,expiry=account?.expiresAt;
      if(!verified.connected||String(account?.status||'').toLowerCase()!=='active'||expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now())||!Number.isFinite(client.authenticatedAt)||Date.now()-client.authenticatedAt>86400000){
        json(res,{error:'Valide novamente sua conta para continuar.',code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'},401);return;
      }
    }
    if(url.pathname==='/api/catalog'){
      const type=url.searchParams.get('type');
      if(!['live','movies','series'].includes(type)){json(res,{error:'Tipo de catálogo inválido.'},400);return;}
      if(state.cloud){
        if(url.searchParams.get('refresh')==='1')await cloudRuntime.refresh(state,'catalog',{media_type:type});
        const shared=await cloudRuntime.catalog(state,type,{fresh:url.searchParams.get('cache')==='reload'});if(Array.isArray(shared?.items)&&Array.isArray(shared?.categories)){json(res,{...shared,catalogComplete:true});return;}
      }
      if(url.searchParams.get('refresh')==='1')client.invalidateCatalog(type);
      const category=url.searchParams.get('category');
      if(category!==null&&client.catalogPage){const page=Number(url.searchParams.get('page')||1);json(res,await cloudRuntime.fallback(state,'catalog',[type,category,page],metadataClient=>metadataClient.catalogPage(type,category,page)));}
      else json(res,await cloudRuntime.fallback(state,'catalog',[type],metadataClient=>metadataClient.catalog(type)));return;
    }
    if(url.pathname==='/api/diagnostics') {
      if(!client.diagnosticPending && (!client.diagnosticLast || Date.now()-client.diagnosticLast.time>15000)) {
        client.diagnosticPending=analyzeConnection(client).then(data=>{client.diagnosticLast={time:Date.now(),data};return data;}).finally(()=>{client.diagnosticPending=null;});
      }
      json(res,client.diagnosticPending?await client.diagnosticPending:client.diagnosticLast.data);return;
    }
    if(url.pathname==='/api/details'){
      const abort=new AbortController(),cancel=()=>abort.abort();res.once('close',cancel);req.once('aborted',cancel);
      try{json(res,await client.details(url.searchParams.get('type'),url.searchParams.get('id'),{probeDuration:url.searchParams.get('duration')==='1',signal:abort.signal}));}
      finally{res.off('close',cancel);req.off('aborted',cancel);}return;
    }
    if(url.pathname==='/api/epg'){const id=url.searchParams.get('id'),shared=state.cloud?await cloudRuntime.epg(state,id):null;json(res,Array.isArray(shared?.list)?shared:await cloudRuntime.fallback(state,'epg',[id],metadataClient=>metadataClient.epg(id)));return;}
    if(url.pathname==='/api/games'){
      const options=gamesRequestOptions({date:url.searchParams.get('date'),timeZone:url.searchParams.get('timezone')||url.searchParams.get('timeZone')||'UTC',lang:url.searchParams.get('lang')||'pt'});
      const shared=state.cloud?await cloudRuntime.games(state,options):null;
      json(res,Array.isArray(shared?.games)?shared:typeof client.games==='function'?await cloudRuntime.fallback(state,'games',[options.date,options.timeZone,options.lang],metadataClient=>metadataClient.games(options)):unavailableGames(options,'A agenda de jogos não está disponível neste tipo de conexão.'));return;
    }
    if(/^\/api\/sports-image\/[a-f0-9]{64}$/.test(url.pathname)){
      const ref=url.pathname.split('/').at(-1),image=await sportsLogoReader(ref);
      if(!image){res.writeHead(404).end();return;}
      const etag='"'+ref+'"',headers={'Content-Type':image.contentType,'Cache-Control':'private, max-age=86400','ETag':etag};
      if(req.headers['if-none-match']===etag){res.writeHead(304,headers).end();return;}
      res.writeHead(200,{...headers,'Content-Length':image.bytes.length});res.end(req.method==='HEAD'?undefined:image.bytes);return;
    }
    if(url.pathname==='/api/image'||/^\/api\/shared-image\/[a-f0-9]{64}$/.test(url.pathname)) {
      const shared=url.pathname.startsWith('/api/shared-image/')?await cloudRuntime.ensureImageSource(state,url.pathname.split('/').at(-1)):null;
      const ref=url.searchParams.get('ref');const source=shared?.source||(url.pathname==='/api/image'?client.images.get(ref):null);if(!source){res.writeHead(404).end();return;}
      if(!imageNamespaces.has(client))imageNamespaces.set(client,randomBytes(18).toString('base64url'));
      const imageKey=shared?'shared:'+url.pathname:imageNamespaces.get(client)+':'+source;
      let image=images.get(imageKey);
      if(!image){
        const upstream=await requestUpstream(source,{allowPrivate:allowPrivateUpstream,timeout:20000,headers:shared?.headers||client.upstreamHeaders?.(source)});
        const contentType=String(upstream.headers['content-type']||'').split(';')[0];
        if(upstream.status!==200||!/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/.test(contentType)){upstream.body.destroy();res.writeHead(404).end();return;}
        const buffer=await readBody(upstream,5*1024*1024);image={buffer,type:contentType};images.set(imageKey,image);imageBytes+=buffer.length;
        while(imageBytes>64*1024*1024){const oldest=images.keys().next().value;imageBytes-=images.get(oldest).buffer.length;images.delete(oldest);}
      }
      res.writeHead(200,{'Content-Type':image.type,'Content-Length':image.buffer.length,'Cache-Control':'private, max-age=3600'});res.end(req.method==='HEAD'?undefined:image.buffer);return;
    }
    let source,key,asset,entrySource;
    const play=/^\/api\/play\/(live|movie|series)\/(\d{1,12})(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.exec(url.pathname);
    if(play){const intent=++client.playbackGeneration;source=await client.playbackURL(play[1],play[2],path.extname(url.pathname).slice(1));if(intent!==client.playbackGeneration||req.aborted||res.destroyed){if(!res.destroyed)res.writeHead(409).end();return;}key=play[1]+':'+play[2];client.beginPlayback(key);entrySource=source;if(play[1]==='live'&&client.playback.manifestURL)source=client.playback.manifestURL;}
    else if(url.pathname.startsWith('/api/asset/')){asset=client.assets.get(url.pathname.slice(11));if(!asset||client.playback?.key!==asset.key){res.writeHead(404).end();return;}source=asset.url;key=asset.key;}
    else {json(res,{error:'Rota não encontrada.'},404);return;}
    const current=client.playback;const abort=new AbortController();const stop=()=>abort.abort();res.on('close',stop);current.controller.signal.addEventListener('abort',stop,{once:true});
    const started=performance.now();let ttfbMs=0,bytes=0,upstreamFailed=false;
    const kind=asset?.mediaDurationSeconds?'segment':play?.[1]==='live'||/\.m3u8(?:[?#]|$)/i.test(String(source))?'playlist':'video';
    try {
      const range=req.headers.range;if(range&&!/^bytes=\d*-\d*$/.test(range)){res.writeHead(416).end();return;}
      const cached=!range&&kind==='segment'&&asset?.cacheKey?client.cachedSegment(asset.cacheKey,key):null;
      if(cached){res.writeHead(200,{'Content-Type':cached.type,'Content-Length':cached.buffer.length,'Cache-Control':'private, max-age=30','Server-Timing':'segmentcache;dur=0'});res.end(req.method==='HEAD'?undefined:cached.buffer);return;}
      const requestOptions={allowPrivate:allowPrivateUpstream,method:req.method,signal:abort.signal,timeout:kind==='playlist'?10000:kind==='segment'?15000:25000,headers:{...client.upstreamHeaders?.(source),...(range?{Range:range}:{})}};
      const mediaRequest=client.upstreamRequest?.bind(client)||requestUpstream;
      let upstream=await mediaRequest(source,requestOptions);
      if(play?.[1]==='live'&&entrySource&&String(source)!==String(entrySource)&&[401,403,404,410].includes(upstream.status)){
        upstream.body.destroy();current.manifestURL=null;source=entrySource;
        requestOptions.headers={...client.upstreamHeaders?.(source),...(range?{Range:range}:{})};
        upstream=await mediaRequest(source,requestOptions);
      }
      ttfbMs=performance.now()-started;
      upstream.body.once('error',()=>{if(!abort.signal.aborted&&!current.controller.signal.aborted)upstreamFailed=true;});
      if(![200,206].includes(upstream.status)){upstream.body.destroy();client.recordTransfer({key,kind,bytes:0,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:false});if(play)playbackError({kind:play[1],code:'PLAYBACK_UPSTREAM_HTTP',status:502,upstreamStatus:upstream.status});json(res,{error:`O provedor não disponibilizou esta mídia (HTTP ${upstream.status}).`},502);return;}
      const manifest=/\.m3u8(?:[?#]|$)/i.test(String(source))||/mpegurl/i.test(String(upstream.headers['content-type']));
      if(manifest&&req.method!=='HEAD') {
        const text=(await readBody(upstream,4*1024*1024)).toString();bytes=Buffer.byteLength(text);
        if(!text.trimStart().startsWith('#EXTM3U'))throw new Error('O provedor retornou um stream incompatível com HLS.');
        if(play?.[1]==='live')current.manifestURL=upstream.url;
        const body=client.rewriteManifest(text,upstream.url,key);res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store','Server-Timing':`upstream;dur=${ttfbMs.toFixed(1)}`});res.end(body);client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,ok:true});return;
      }
      const headers={'Content-Type':upstream.headers['content-type']||(/\.mp4/.test(upstream.url)?'video/mp4':'application/octet-stream'),'Cache-Control':kind==='segment'?'private, max-age=30':'no-store','Server-Timing':`upstream;dur=${ttfbMs.toFixed(1)}`};
      for(const name of ['content-length','content-range','accept-ranges'])if(upstream.headers[name])headers[name]=upstream.headers[name];
      if(upstream.headers['content-encoding'])delete headers['content-length'];
      res.writeHead(upstream.status,headers);
      if(req.method==='HEAD'){upstream.body.destroy();res.end();return;}
      const chunks=[];let retain=kind==='segment'&&!range&&!!asset?.cacheKey;
      const meter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(retain){if(bytes>8*1024*1024){retain=false;chunks.length=0;}else chunks.push(chunk);}callback(null,chunk);}});
      await pipeline(upstream.body,meter,res);
      client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:true});
      if(retain&&asset?.cacheKey)client.cacheSegment(asset.cacheKey,key,Buffer.concat(chunks),headers['Content-Type']);
    } catch(error) {if(!current.controller.signal.aborted&&(!abort.signal.aborted||upstreamFailed))client.recordTransfer({key,kind,bytes,ttfbMs,durationMs:performance.now()-started,mediaDurationSeconds:asset?.mediaDurationSeconds||null,ok:false});throw error;
    } finally {res.off('close',stop);current.controller.signal.removeEventListener('abort',stop);}
  }
  const server=http.createServer(async(req,res)=>{
    if(shuttingDown){res.writeHead(503,{'Connection':'close'}).end();return;}
    const host=req.headers.host||'';
    if(!/^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host)){res.writeHead(403).end();return;}
    await cloudRuntime.ready;
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const cloudConnections=cloudRuntime.enabled?` https://${ARKHEN_SUPABASE_PROJECT}.supabase.co wss://${ARKHEN_SUPABASE_PROJECT}.supabase.co`:'';
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'${cloudConnections}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    let url;
    try {url=new URL(req.url,'http://'+host);}catch{res.writeHead(400).end('Endereço inválido');return;}
    try {
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin&&!['http://'+host,'https://'+host].includes(req.headers.origin))){json(res,{error:'Origem da requisição não permitida.'},403);return;}
        await api(req,res,url);return;
      }
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      const pathname=decodeURIComponent(url.pathname);const requested=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      if(!requested.startsWith(root)){res.writeHead(403).end();return;}
      const file=await realpath(requested);if(!file.startsWith(root)){res.writeHead(403).end();return;}
      const info=await stat(file);if(!info.isFile()){res.writeHead(404).end();return;}
      const logoAsset=/^\/assets\/channels\/[a-z0-9-]+-[a-f0-9]{16}\.webp$/.test(pathname);
      const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':logoAsset?'public, max-age=31536000, immutable':'no-cache'};
      let start=0,end=info.size-1,status=200;
      if(req.headers.range){const range=parseRange(req.headers.range,info.size);if(!range){res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();return;}({start,end}=range);status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;}
      headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
      if(req.method==='HEAD'||info.size===0){res.end();return;}
      await pipeline(createReadStream(file,{start,end}),res);
    } catch(error) {
      const failedPlay=/^\/api\/play\/(live|movie|series)\/\d{1,12}(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.exec(url.pathname);
      if(failedPlay&&!req.aborted&&!res.destroyed&&error?.name!=='AbortError'&&error?.code!=='ABORT_ERR'){
        const status=error instanceof ProviderError&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502;
        playbackError({kind:failedPlay[1],code:error?.code||error?.cause?.code||error?.errors?.find(value=>typeof value?.code==='string')?.code,status});
      }
      if(res.destroyed)return;
      if(res.headersSent){res.destroy();return;}
      if(url.pathname.startsWith('/api/')){const token=req.headers.cookie?.match(/ORBIT_SID=([\w-]+)/)?.[1];json(res,{error:friendly(error,sessions.get(token)?.client),code:error instanceof ProviderError?error.code:'CONNECTION_FAILED'},error instanceof ProviderError&&[400,401,403,404,409,422,429,501,502,503,504].includes(error.status)?error.status:502);}
      else res.writeHead(404).end('Arquivo não encontrado');
    }
  });
  let cleanup,shutdown;
  const closeSessions=()=>{
    if(!cleanup){
      shuttingDown=true;
      cloudRuntime.close();
      const clients=[];
      for(const state of sessions.values()){state.authGeneration++;cloudRuntime.detach(state);clients.push(state.client);state.client=null;}
      sessions.clear();cleanup=Promise.all(clients.map(releaseClient)).then(async()=>{await (await bridge)?.shutdown?.();});
    }
    return cleanup;
  };
  server.on('close',()=>{void closeSessions().catch(()=>{});});
  server.shutdown=()=>{
    if(!shutdown)shutdown=(async()=>{
      const closed=new Promise(resolve=>server.close(resolve));
      server.closeIdleConnections?.();
      try{await closeSessions();}
      finally{server.closeAllConnections?.();await closed;}
    })();
    return shutdown;
  };
  return server;
}
