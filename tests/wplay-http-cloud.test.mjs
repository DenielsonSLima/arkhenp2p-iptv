import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createWplayHttpSource,sharedImageReference,publicWplayURL,wplayTokenURL,wplayTimestamp,cloudGamesOffset,cloudGamesOptions} from '../supabase/functions/arkhen-catalog-sync/wplay-http.mjs';
import {normalizeWplayEPG} from '../lib/wplay/ao-vivo/grade.mjs';
import {normalizeWplayGames} from '../lib/wplay/ao-vivo/jogos.mjs';

const resolveDns=async()=>['93.184.215.14'];
const NOW=Date.parse('2026-10-15T01:30:00Z'),providerKey='a'.repeat(64),scopeHash='b'.repeat(64),scope={providerKey,scopeHash};
const movie=(id=101,extra={})=>({chid:id,name:{init:'Filme &amp; teste'},tags:[{_id:50,name:{init:'Lançamentos'}}],year:2026,rating:8.2,updatedAt:'2026-10-15',description:'<b>Sinopse</b>',logo:{image:{big:'https://art.example.com/portrait.jpg?t=private-token',full:'https://art.example.com/landscape.jpg'}},image_logo:'https://art.example.com/title-lettering.png',duration:'00:52:09',sources:[{address:'https://video.example.com/private-stream',password:'private-password'}],password:'private-password',...extra});
const series=(id=201)=>movie(id,{name:{init:'Série de teste'},tags:[],seasonCount:1,sources:[{_id:701,subTitle:'S01E001',address:'https://video.example.com/private-stream'}]});
const tag=(id,name,extra={})=>({_id:id,name:{init:name},url:`https://catalog.example.com/category/${id}?view=small`,...extra});
function fixture({native=true,fetch:providedFetch,mapImage,service={},response}={}){
  const calls=[],images=[],source={provider:'wplay',userAgent:'Apache-HttpClient/Null (WPlay fixture; Android; fixture)',service:{token:'private-token',ch_url:'https://catalog.example.com/live',vod_url:'https://catalog.example.com/legacy',...(native?{vod_tag_url:'https://catalog.example.com/tags'}:{}),epg_url:'https://epg.example.com/all?region=br',football_url:'https://games.example.com/api/v1?region=br',...service}};
  const fetch=providedFetch||(async(url,options)=>{
    calls.push({url,options});const parsed=new URL(url);let payload;
    if(response){const reply=await response(parsed,options);if(reply instanceof Response)return reply;if(reply!==undefined)payload=reply;}
    if(payload===undefined){
      if(parsed.pathname==='/tags')payload=[{group_id:49,group_name:{init:'Filmes'},items:[tag(80,'Ação'),tag(50,'Lançamentos')]},{group_id:1009,group_name:'Séries',items:[tag(1009,'Top 10')]},{group_id:18,group_name:'+18',restrictedAccess:true,items:[tag(1801,'VIP Filmes')]},{group_id:99,group_name:'Cinema',items:[tag('opaque-id','Drama')]}];
      else if(parsed.pathname.startsWith('/category/')){const page=Number(parsed.searchParams.get('page')),id=parsed.pathname.split('/').at(-1);payload=page>2?[]:id==='1009'?[series()]:id==='1801'?[movie(199)]:page===2?[movie(102)]:[movie()];}
      else if(parsed.pathname==='/live')payload=[{chid:1,name:{init:'Adult Swim HD'},tags:[{_id:3,name:'Adult Swim'}],epgSameAs:91},{chid:2,name:'Cultura',tags:[{_id:4,name:'Cultura'}]}];
      else if(parsed.pathname==='/legacy')payload=[movie(),series()];
      else if(parsed.pathname==='/all')payload=[{id:91,epg:[{name:'Programa &amp; atual',time:'2026-10-15T10:00:00Z',endTime:'2026-10-15T11:00:00Z',playbackUrl:'https://replay.example.com/private-token'}]},{id:2,epg:[{name:'Outro programa',time:'2026-10-15T10:00:00Z',endTime:'2026-10-15T11:00:00Z'}]}];
      else if(parsed.pathname==='/api/v1/games')payload={code:200,data:[{id:'42',name:'Time A &amp; Time B',date:'2026-10-15 13:40',status:'1',league:{id:'liga',name:'Liga',logo:'https://art.example.com/league.png'},teams:[{id:'a',name:'Time A'},{id:'b',name:'Time B'}],channels:[{chid:1,name:{init:'Canal Esporte'},sources:[{address:'private-stream'}]}],password:'private-password'}]};
      else throw new Error('Unexpected fixture endpoint');
    }
    return Response.json(payload);
  });
  const adapter=createWplayHttpSource({source,fetch,resolveDns,now:()=>NOW,mapImage:mapImage||(async(url,context)=>{images.push({url,context});return sharedImageReference(url,scope);})});
  return {adapter,calls,images,source};
}

test('native catalog registration is one small coalesced request and exposes only stable category identities',async()=>{
  const f=fixture(),[movies,shows]=await Promise.all([f.adapter.registerCategories('movies'),f.adapter.registerCategories('series')]);
  assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0].url).pathname,'/tags');assert.match(f.calls[0].url,/\?t=private-token$/);
  assert.equal(f.calls[0].options.headers['User-Agent'],f.source.userAgent);assert.equal(f.calls[0].options.redirect,'error');assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.ok(movies.some(value=>value.id==='1801'&&value.isAdult===true));assert.ok(!movies.some(value=>value.id==='1009'));assert.deepEqual(shows.map(value=>value.id),['1009']);
  const expected=String(BigInt('0x'+createHash('sha256').update('category:99:opaque-id').digest('hex').slice(0,16))%1000000000000n);assert.ok(movies.some(value=>value.id===expected));
  assert.doesNotMatch(JSON.stringify([movies,shows]),/https:|private-token|url|hint|userAgent/);
});

test('native pages follow their registered URL and original token verbatim until the provider returns an empty array',async()=>{
  const f=fixture({service:{token:'opaque+token/with=chars'}}),page=await f.adapter.catalogPage('movies','80',1);
  assert.equal(f.calls[1].url,'https://catalog.example.com/category/80?view=small&t=opaque+token/with=chars&page=1');assert.equal(page.hasMore,true);assert.equal(page.nextPage,2);
  assert.deepEqual(new Set(page.items[0].categoryIds),new Set(['80','50']));assert.equal(page.items[0].durationSeconds,3129);assert.equal(page.items[0].name,'Filme & teste');
  assert.equal(page.items[0].poster,await sharedImageReference('https://art.example.com/portrait.jpg?t=private-token',scope));assert.equal(page.items[0].backdrop,await sharedImageReference('https://art.example.com/landscape.jpg',scope));
  assert.ok(!f.images.some(value=>value.url.includes('title-lettering')));assert.equal(f.images[0].context.kind,'movie');
  assert.doesNotMatch(JSON.stringify(page),/private-token|private-password|video\.example.com|address|sources|password|userAgent|catalog\.example.com/);
  const end=await f.adapter.catalogPage('movies','80',3);assert.equal(end.hasMore,false);assert.equal(end.items.length,0);assert.ok(!f.calls.some(value=>new URL(value.url).pathname==='/legacy'));
});

test('catalog metadata retains only explicitly validated IMDb and TMDB identifiers',async()=>{
  const rows=[movie(1,{imdb_id:'tt0944947',tmdb_id:'1399'}),movie(2,{imdbId:'tt123456',tmdbId:42}),movie(3,{imdbId:'https://imdb.example.com/private',tmdbId:'7?token=private'}),movie(4,{imdbId:123456,tmdbId:-2})],f=fixture({native:false,response:url=>url.pathname==='/legacy'?rows:undefined});
  const items=(await f.adapter.catalog('movies')).items;assert.equal(items[0].imdbId,'tt0944947');assert.equal(items[0].tmdbId,1399);assert.equal(items[1].imdbId,'tt123456');assert.equal(items[1].tmdbId,42);
  for(const item of items.slice(2)){assert.equal(item.imdbId,undefined);assert.equal(item.tmdbId,undefined);}assert.doesNotMatch(JSON.stringify(items),/private|https:/);
});

test('checkpoint steps retain deterministic category ordering, terminal empty pages and explicit adult categories',async()=>{
  const f=fixture(),categories=await f.adapter.registerCategories('movies');let cursor={categoryIndex:0,page:1},steps=0,complete=false,adultSeen=false;
  while(cursor){const step=await f.adapter.catalogStep('movies',cursor);steps++;adultSeen ||=step.items.some(item=>item.isAdult);assert.deepEqual(step.categories.filter(row=>categories.some(value=>value.id===row.id)).map(row=>row.id),categories.map(row=>row.id));cursor=step.next;complete=step.complete;assert.ok(steps<30);}
  assert.equal(complete,true);assert.equal(steps,categories.length*3);assert.equal(adultSeen,true);
  const restart=fixture();assert.deepEqual(await restart.adapter.registerCategories('movies'),categories);
  await assert.rejects(f.adapter.catalogStep('movies',{categoryIndex:-1,page:1}),{code:'WPLAY_CATEGORY_CURSOR_INVALID'});await assert.rejects(f.adapter.catalogPage('movies','unknown',1),{code:'WPLAY_CATEGORY_INVALID'});await assert.rejects(f.adapter.catalogPage('movies','80',0),{code:'WPLAY_PAGE_INVALID'});
});

test('an unmarked raw tag cannot clear the authoritative restriction flag or expose an adult item in another category',async()=>{
  const f=fixture({response:url=>url.pathname.startsWith('/category/')?[movie(199,{tags:[{_id:1801,name:'VIP Filmes'}]})]:undefined});
  const direct=await f.adapter.catalogPage('movies','1801',1);assert.equal(direct.items[0].isAdult,true);assert.equal(direct.categories.find(row=>row.id==='1801').isAdult,true);
  const another=await f.adapter.catalogStep('movies',{categoryIndex:1,page:1});assert.equal(another.items[0].isAdult,true);assert.equal(another.categories.find(row=>row.id==='1801').isAdult,true);
});

test('native catalog convenience is an unconsumed page plan, not an eager traversal',async()=>{
  const f=fixture(),catalog=await f.adapter.catalog('movies');assert.equal(f.calls.length,1);assert.equal(catalog.items.length,0);assert.equal(catalog.pagination.mode,'category');assert.ok(Object.values(catalog.pagination.byCategory).every(value=>value.nextPage===1&&value.hasMore&&!value.loaded));
});

test('a nonempty native page containing another media kind is not mistaken for end of pagination',async()=>{
  const f=fixture({response:url=>url.pathname==='/category/80'?[series()]:undefined}),page=await f.adapter.catalogPage('movies','80',1);assert.equal(page.items.length,0);assert.equal(page.hasMore,true);assert.equal(page.nextPage,2);
});

test('live and legacy VOD each download once, preserve source-derived media kinds and keep Adult Swim safe',async()=>{
  const f=fixture({native:false}),[movies,shows,live,liveAgain]=await Promise.all([f.adapter.catalog('movies'),f.adapter.catalog('series'),f.adapter.catalog('live'),f.adapter.catalog('live')]);
  assert.equal(f.calls.filter(value=>new URL(value.url).pathname==='/legacy').length,1);assert.equal(f.calls.filter(value=>new URL(value.url).pathname==='/live').length,1);
  assert.deepEqual(movies.items.map(item=>item.id),['101']);assert.deepEqual(shows.items.map(item=>item.id),['201']);assert.equal(live.items[0].isAdult,undefined);assert.deepEqual(liveAgain,live);assert.equal(live.catalogComplete,true);
  assert.doesNotMatch(JSON.stringify([movies,shows,live]),/private|https:|sources|address|token/);
});

test('global EPG downloads once, maps epgSameAs to actual channel IDs and matches the existing UTC parser',async()=>{
  const f=fixture(),[first,second]=await Promise.all([f.adapter.epg(),f.adapter.epg()]);assert.deepEqual(first,second);
  assert.equal(f.calls.filter(value=>new URL(value.url).hostname==='epg.example.com').length,1);assert.equal(f.calls.filter(value=>new URL(value.url).pathname==='/live').length,1);
  assert.deepEqual(first.channels.map(value=>value.channel_id),['1','2']);assert.equal(first.channels[0].payload.list[0].title,'Programa & atual');assert.equal(first.channels[0].payload.list[0].start,'2026-10-15T10:00:00.000Z');
  const payload=[{id:1,epg:[{name:'Madrugada',time:'2026-10-14T23:30:00.000-0300',endTime:'2026-10-15T00:30:00.000-0300'}]}],normalized=normalizeWplayEPG(payload);
  assert.equal(wplayTimestamp(payload[0].epg[0].time),Date.parse(normalized.get('1')[0].start));for(const invalid of ['2026-02-30T10:00:00Z','2026-10-15T10:00:00','2026-10-15T25:00:00Z',null])assert.equal(wplayTimestamp(invalid),null);
  assert.doesNotMatch(JSON.stringify(first),/replay|private|playback|https:/);
});

test('games retain the exact endpoint/query contract and verified UTC dates without inventing a local time',async()=>{
  const f=fixture(),options={date:'2026-10-15',timeZone:'America/Maceio',lang:'pt'},result=await f.adapter.games(options),url=new URL(f.calls[0].url);
  assert.equal(url.pathname,'/api/v1/games');assert.deepEqual(Object.fromEntries(url.searchParams),{region:'br',date:'2026-10-15',timezone:'-03:00',lang:'pt',t:'private-token'});assert.equal(result.games[0].start,'2026-10-15T13:40:00.000Z');assert.equal(result.games[0].title,'Time A & Time B');assert.deepEqual(result.games[0].channels,[{id:'1',name:'Canal Esporte'}]);
  assert.equal(f.images[0].context.kind,'sports-logo');assert.doesNotMatch(JSON.stringify(result),/private|https:|sources|password|token/);
  await f.adapter.games(options);assert.equal(f.calls.length,1);assert.equal(cloudGamesOffset({...options,timeZone:'Asia/Kathmandu'}),'+05:45');assert.equal(cloudGamesOffset({...options,date:'2026-01-15',timeZone:'America/New_York'}),'-05:00');assert.equal(cloudGamesOffset({...options,date:'2026-07-15',timeZone:'America/New_York'}),'-04:00');
  assert.equal(cloudGamesOptions({timeZone:'America/Maceio'},NOW).date,'2026-10-14');
  for(const value of [{date:'2026-02-30'},{timeZone:'Bad/Zone'},{lang:'pt&secret=token'}])assert.throws(()=>cloudGamesOptions({...options,...value}),{code:'WPLAY_GAMES_REQUEST_INVALID'});
});

test('games support explicit offsets/numeric timestamps and reject business errors or malformed envelopes',async()=>{
  const data=[{id:'1',date:'2026-10-15T13:40:00-03:00'},{id:'2',date:1792071600},{id:'3',date:'2026-02-30 13:40'}],f=fixture({response:url=>url.hostname==='games.example.com'?{code:0,data}:undefined});
  const actual=(await f.adapter.games({date:'2026-10-15',timeZone:'UTC'})).games,expected=normalizeWplayGames({code:0,data},{timeZoneOffset:'+00:00'});assert.deepEqual(actual,expected);
  for(const payload of [{code:403,data:[],message:'private-token'},null,[],{data:{}}]){const f=fixture({response:()=>Response.json(payload)});await assert.rejects(f.adapter.games({date:'2026-10-15'}),error=>/^WPLAY_(?:GAMES_REJECTED|INVALID_GAMES)$/.test(error.code)&&!/private/.test(error.message));}
});

test('opaque image references exactly match Node canonicalization and discard session-bound mapper results',async()=>{
  const value='https://art.example.com/cover.jpg?z=2&token=private&a=1#fragment',url=new URL(value);url.hash='';url.searchParams.delete('token');url.searchParams.sort();const expected='/api/shared-image/'+createHash('sha256').update(JSON.stringify([providerKey,scopeHash,url.href])).digest('hex');assert.equal(await sharedImageReference(value,scope),expected);
  const f=fixture({mapImage:async()=>'/api/image?ref=private-session'}),page=await f.adapter.catalogPage('movies','80',1);assert.equal(page.items[0].poster,'');assert.equal(page.items[0].backdrop,'');
  await assert.rejects(sharedImageReference(value,{providerKey:'invalid',scopeHash}),{code:'WPLAY_IMAGE_SCOPE_INVALID'});
});

test('public transport rejects credentials, local targets, redirects/status failures, invalid JSON and excessive decoded bytes',async()=>{
  for(const value of ['http://localhost/x','http://localhost./x','http://127.0.0.1/x','http://0x7f000001/x','http://169.254.169.254/latest','http://10.1.2.3/x','http://172.20.0.1/x','http://192.168.1.2/x','http://[::1]/x','file:///secret','https://user:password@catalog.example.com/live'])assert.throws(()=>publicWplayURL(value),{code:'WPLAY_SERVICE_URL_INVALID'},value);
  for(const [response,code]of [[new Response('not-json'),'WPLAY_INVALID_RESPONSE'],[new Response('private-url',{status:302,headers:{Location:'https://private.example.com'}}),'WPLAY_UPSTREAM_HTTP'],[new Response('private-url',{status:401}),'WPLAY_UPSTREAM_HTTP'],[new Response('[]',{headers:{'Content-Length':String(65*1024*1024)}}),'WPLAY_RESPONSE_TOO_LARGE']]){const f=fixture({fetch:async()=>response});await assert.rejects(f.adapter.catalog('live'),error=>error.code===code&&!/private/.test(error.message));}
  const f=fixture({fetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4*1024*1024+1));controller.close();}}))});await assert.rejects(f.adapter.registerCategories('movies'),{code:'WPLAY_RESPONSE_TOO_LARGE'});
});

test('transport fails closed for private, mixed, missing or unresolved DNS answers before any HTTP request',async()=>{
  for(const resolver of [async()=>['169.254.169.254'],async()=>['93.184.215.14','10.1.2.3'],async()=>[],async()=>{throw new Error('DNS unavailable');},null]){
    let calls=0;const source={provider:'wplay',service:{ch_url:'https://catalog.example.com/live'},userAgent:'fixture'},adapter=createWplayHttpSource({source,resolveDns:resolver,fetch:async()=>{calls++;return Response.json([]);}});
    await assert.rejects(adapter.catalog('live'),{code:'WPLAY_SERVICE_URL_INVALID'});assert.equal(calls,0);
  }
});

test('disabled or absent capabilities do not guess endpoints and the adapter contains no Node or DOM dependency',async()=>{
  const f=fixture({service:{enabledLive:false,enabledVoD:false,football_url:'',epg_url:''}});assert.deepEqual(await f.adapter.catalog('movies'),{categories:[],items:[],catalogComplete:true});assert.deepEqual(await f.adapter.catalog('live'),{categories:[],items:[],catalogComplete:true});assert.deepEqual(await f.adapter.epg(),{channels:[]});assert.equal((await f.adapter.games({date:'2026-10-15'})).available,false);assert.equal(f.calls.length,0);
  assert.throws(()=>createWplayHttpSource({source:{provider:'xtream',service:{},userAgent:'fixture'}}),{code:'WPLAY_SOURCE_INVALID'});assert.equal(wplayTokenURL('https://example.test/list?t=bound','new-token'),'https://example.test/list?t=bound');
  const source=await readFile(new URL('../supabase/functions/arkhen-catalog-sync/wplay-http.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/(?:from\s+['"]node:|\bBuffer\b|\bdocument\.|\brequire\()/);
});

test('an aborted HTTP operation has a safe timeout code and a failed page is retryable',async()=>{
  const source={provider:'wplay',service:{ch_url:'https://catalog.example.com/live'},userAgent:'fixture'};let calls=0;
  const adapter=createWplayHttpSource({source,resolveDns,timeoutMs:5,fetch:async(_url,{signal})=>{calls++;if(calls>1)return Response.json([]);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('private-url-token')),{once:true}));}});
  await assert.rejects(adapter.catalog('live'),error=>error.code==='WPLAY_UPSTREAM_TIMEOUT'&&!/private/.test(error.message));assert.deepEqual(await adapter.catalog('live'),{categories:[],items:[],catalogComplete:true});assert.equal(calls,2);
});
