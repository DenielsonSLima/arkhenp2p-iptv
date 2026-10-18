import test from 'node:test';
import assert from 'node:assert/strict';
import {WplayProviderClient} from '../lib/wplay/conexao/provedor-nativo.mjs';
import {gamesRequestOptions, gamesTimezoneOffset, normalizeWplayGames, WPLAY_GAMES_CACHE_MS, WPLAY_GAMES_MAX_BYTES} from '../lib/wplay/ao-vivo/jogos.mjs';

const options={date:'2026-10-14',timeZone:'America/Maceio',lang:'pt'};
const rawGame=(id='game-1')=>({id,name:'Time A &amp; Time B',date:'2026-10-14T20:30:00.000-03:00',status:'scheduled',score:'',
  league:{id:'league-1',name:'Liga',logo:'https://art.example/league.png'},
  teams:[{id:'a',name:'Time A',logo:'https://art.example/a.png'},{id:'b',name:'Time B',logo:'https://art.example/b.png'}],
  channels:[{chid:248,name:{init:'Canal Esporte'},sources:[{address:'private-stream-url'}],token:'private-token'},{chid:248},{chid:0},{chid:'https://other.example'}],
  password:'private-password',token:'private-token',playbackURL:'private-stream-url'});
function fixture() {
  const client=new WplayProviderClient({username:'fixture',password:'private-password'},{sportsLogos:null});
  client.session={connected:true};client.authenticatedAt=Date.now();
  client.authInfo={service:{football_url:'https://games.example/api/v1?region=br',token:'private-token'}};
  const calls=[];
  client.requestJSON=async(url,settings)=>{calls.push({url,settings});return {code:0,data:[rawGame()]};};
  return {client,calls};
}

test('request options validate real dates and IANA zones, with today derived in the requested zone', () => {
  assert.deepEqual(gamesRequestOptions(options),options);
  assert.equal(gamesRequestOptions({timeZone:'America/Maceio'},Date.parse('2026-10-15T01:30:00Z')).date,'2026-10-14');
  for(const value of [{date:'2026-02-30'},{date:'../../private'},{date:'2026-2-3'},{timeZone:'https://private.example'},{timeZone:'Bad/Zone'},{lang:'pt&token=secret'},{date:123}]) {
    assert.throws(()=>gamesRequestOptions({...options,...value}),{code:'WPLAY_GAMES_REQUEST_INVALID',status:400});
  }
});

test('provider timezone uses the APK offset format for the selected day, including seasonal and fractional offsets', () => {
  assert.equal(gamesTimezoneOffset(options),'-03:00');
  assert.equal(gamesTimezoneOffset({...options,timeZone:'UTC'}),'+00:00');
  assert.equal(gamesTimezoneOffset({...options,timeZone:'Asia/Kathmandu'}),'+05:45');
  assert.equal(gamesTimezoneOffset({...options,date:'2026-01-15',timeZone:'America/New_York'}),'-05:00');
  assert.equal(gamesTimezoneOffset({...options,date:'2026-07-15',timeZone:'America/New_York'}),'-04:00');
});

test('the original APK envelope maps only game, team and channel metadata and never exposes stream credentials', () => {
  const games=normalizeWplayGames({code:0,data:[rawGame(),rawGame(),null,{id:'invalid/url',name:'Invalid'}]}, {image:()=>'/api/image?ref=opaque'});
  assert.equal(games.length,1);const game=games[0];
  assert.equal(game.title,'Time A & Time B');assert.equal(game.start,'2026-10-14T23:30:00.000Z');
  assert.deepEqual(game.homeTeam,{id:'a',name:'Time A',logo:'/api/image?ref=opaque'});
  assert.equal(game.awayTeam.name,'Time B');assert.equal(game.league.name,'Liga');
  assert.deepEqual(game.channels,[{id:'248',name:'Canal Esporte'}]);
  assert.doesNotMatch(JSON.stringify(games),/private|https:|sources|playbackURL|password|token/);
  const missing=normalizeWplayGames({data:[{id:'1',date:'2026-10-14 20:30:00'}, {id:'2',date:1792011000}]});
  assert.equal(missing[0].start,null);assert.equal(missing[0].title,'');assert.equal(missing[0].homeTeam,null);assert.equal(missing[0].score,'');
  assert.equal(missing[1].start,new Date(1792011000*1000).toISOString());
  for(const payload of [null,[],{data:{}},{games:[]}])assert.throws(()=>normalizeWplayGames(payload),{code:'WPLAY_INVALID_GAMES'});
});

test('the code-200 envelope converts bare dates only with an explicit timestamp contract',()=>{
  const payload={code:200,data:[{id:'game-42',date:'2026-10-15 13:40',status:'1',teams:[{id:'home',name:'Time A'},{id:'away',name:'Time B'}],channels:[]},
    {id:'game-43',date:'2026-10-15 14:05:32',status:'3',teams:[],channels:[]}]};
  const games=normalizeWplayGames(payload,{timeZoneOffset:'-03:00'});
  assert.equal(games[0].start,'2026-10-15T16:40:00.000Z');assert.equal(games[0].status,'1');assert.equal(games[0].homeTeam.name,'Time A');assert.deepEqual(games[0].channels,[]);
  assert.equal(games[1].start,'2026-10-15T17:05:32.000Z');assert.equal(games[1].status,'3');
  assert.equal(normalizeWplayGames(payload)[0].start,null,'A bare time without the authenticated request context remains unknown.');
  assert.equal(normalizeWplayGames(payload,{timeZoneOffset:'+05:45'})[0].start,'2026-10-15T07:55:00.000Z');
  assert.equal(normalizeWplayGames(payload,{timeZoneOffset:'+00:00'})[0].start,'2026-10-15T13:40:00.000Z');
  for(const timeZoneOffset of ['America/Maceio','-03:60','-24:00','bad',null])assert.equal(normalizeWplayGames(payload,{timeZoneOffset})[0].start,null);
});

test('invalid wall-clock dates cannot become normalized-looking dates even with a known request offset',()=>{
  for(const date of ['2026-02-30 13:40','2026-13-15 13:40','2026-10-00 13:40','2026-10-15 24:00','2026-10-15 13:60','2026-10-15 13:40:60','15/10/2026 13:40']){
    const games=normalizeWplayGames({code:200,data:[{id:'1',date}]},{timeZoneOffset:'-03:00'});assert.equal(games[0].start,null,date);
  }
  const explicit=normalizeWplayGames({data:[rawGame()]},{timeZoneOffset:'+05:45'});assert.equal(explicit[0].start,'2026-10-14T23:30:00.000Z','An explicit timestamp keeps its own offset.');
});

test('provider business errors never masquerade as an empty successful agenda or leak provider messages',()=>{
  for(const code of [403,401,500,-1,'403',null]){
    assert.throws(()=>normalizeWplayGames({code,data:[],message:'https://private.example/?token=private-token'}),error=>error.code==='WPLAY_GAMES_REJECTED'&&error.status===502&&!/https:|private|token/.test(error.message));
  }
  for(const code of [undefined,0,200])assert.deepEqual(normalizeWplayGames({code,data:[]}),[]);
});

test('the WPLAY adapter treats the verified date field as UTC independently of the day-window query offset',async()=>{
  const {client,calls}=fixture();client.requestJSON=async(url,settings)=>{calls.push({url,settings});return {code:200,data:[{id:'42',date:'2026-10-15 13:40',status:'1',channels:[]}]};};
  const result=await client.games({...options,date:'2026-10-15'});
  assert.equal(new URL(calls[0].url).searchParams.get('timezone'),'-03:00');assert.equal(result.games[0].start,'2026-10-15T13:40:00.000Z');
  const utc=await client.games({...options,date:'2026-10-15',timeZone:'UTC'});assert.equal(utc.games[0].start,result.games[0].start);
  client.requestJSON=async()=>({code:403,data:[],message:'private-token'});
  await assert.rejects(client.games({...options,date:'2026-10-16'}),{code:'WPLAY_GAMES_REJECTED',status:502});
});

test('native games use the configured football base, exact APK query names and existing token transport', async () => {
  const {client,calls}=fixture();
  const [first,second]=await Promise.all([client.games(options),client.games(options)]);
  assert.deepEqual(first,second);assert.equal(calls.length,1);
  const url=new URL(calls[0].url);
  assert.equal(url.pathname,'/api/v1/games');
  assert.deepEqual(Object.fromEntries(url.searchParams),{region:'br',date:options.date,timezone:'-03:00',lang:'pt',t:'private-token'});
  assert.equal(calls[0].settings.maxBytes,WPLAY_GAMES_MAX_BYTES);
  assert.equal(first.available,true);assert.equal(first.date,options.date);assert.equal(first.timeZone,options.timeZone);
  assert.doesNotMatch(JSON.stringify(first),/private|games\.example/);
  assert.equal(WPLAY_GAMES_CACHE_MS,60000);
  const entry=[...client.cache].find(([key])=>key.startsWith('wplay:games:'));
  entry[1].time-=WPLAY_GAMES_CACHE_MS+1;await client.games(options);assert.equal(calls.length,2);
});

test('real provider team and league URLs enter the persistent shared-logo queue without delaying the agenda',async()=>{
  const {client}=fixture(),calls=[],route='/api/sports-image/'+'a'.repeat(64);
  client.sportsLogos={queue(value,options){calls.push({value,options});return route;}};
  const result=await client.games(options);assert.equal(calls.length,3);
  assert.deepEqual(calls.map(call=>call.value).sort(),['https://art.example/a.png','https://art.example/b.png','https://art.example/league.png']);
  assert.equal(result.games[0].league.logo,route);assert.equal(result.games[0].homeTeam.logo,route);assert.equal(result.games[0].awayTeam.logo,route);
  assert.ok(calls.every(call=>call.options.scope===client.config.server&&call.options.headers['User-Agent']===client.userAgent));assert.doesNotMatch(JSON.stringify(result),/https:|private-token/);
});

test('cache identity follows date, language, timezone and renewed authenticated service URLs', async () => {
  const {client,calls}=fixture();
  await client.games(options);await client.games({...options,date:'2026-10-15'});
  await client.games({...options,lang:'en'});await client.games({...options,timeZone:'UTC'});
  client.authInfo.service.token='renewed-private-token';await client.games(options);
  assert.equal(calls.length,5);assert.ok(calls.at(-1).url.includes('renewed-private-token'));
  const another=fixture();await another.client.games(options);assert.equal(another.calls.length,1);
});

test('a configured football query token is preserved without appending a second credential', async () => {
  const {client,calls}=fixture();
  client.authInfo.service.football_url='https://games.example/api/v1/?t=base-bound-token&region=br';
  await client.games(options);
  const url=new URL(calls[0].url);
  assert.equal(url.pathname,'/api/v1/games');
  assert.deepEqual(url.searchParams.getAll('t'),['base-bound-token']);
  assert.equal(url.searchParams.get('region'),'br');
  assert.equal(url.searchParams.get('date'),options.date);
  assert.equal(url.searchParams.get('timezone'),'-03:00');
  assert.doesNotMatch(calls[0].url,/private-token/);
});

test('missing football configuration does not guess a source and network failures remain retryable without private URL leakage', async () => {
  const {client,calls}=fixture();client.authInfo.service.football_url='';
  assert.deepEqual(await client.games(options),{available:false,date:options.date,timeZone:options.timeZone,games:[],message:'O serviço não disponibilizou a agenda de jogos para esta conta.'});
  assert.equal(calls.length,0);
  client.authInfo.service.football_url='https://games.example/api/v1';let attempts=0;
  client.requestJSON=async()=>{attempts++;throw new Error('https://private.example/?token=private-token');};
  for(let i=0;i<2;i++)await assert.rejects(client.games(options),error=>error.code==='WPLAY_GAMES_UNAVAILABLE'&&!/private|https:/.test(error.message));
  assert.equal(attempts,2);
  client.authInfo.service.football_url='http://127.0.0.1/private?token=secret';
  await assert.rejects(client.games(options),{code:'WPLAY_GAMES_UNAVAILABLE'});assert.equal(attempts,2);
});
