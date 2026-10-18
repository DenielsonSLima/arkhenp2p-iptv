import test from 'node:test';
import assert from 'node:assert/strict';
import {OrquestradorConexaoWplay} from '../lib/wplay/orquestrador.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {WplayOTTProviderClient} from '../lib/wplay/ott/provedor.mjs';
import {ProviderClient} from '../lib/provider.mjs';
import {WPLAY_AUTH_URLS} from '../lib/wplay/conexao/autenticacao.mjs';
import {createCloudAttachment,wplayProviderAuthenticationOptions} from '../lib/wplay/conector-supabase.mjs';
import {configuredConnection} from '../lib/wplay/conexao/configuracao.mjs';

const input={username:'synthetic-user',password:'synthetic-password'};

test('connection selects existing adapters and leaves authentication lazy',async()=>{
  const connection=new OrquestradorConexaoWplay();
  const native=connection.resolveConnection(input);
  assert.equal(native.provider,'wplay');assert.equal(native.options.webPlayback,true);
  assert.deepEqual(native.config.authURLs,[WPLAY_AUTH_URLS[1],WPLAY_AUTH_URLS[0]]);
  const client=await connection.createClient(native);
  assert.ok(client instanceof WplayPlaybackProviderClient);assert.equal(client.session,null);
  assert.equal(client.domains.series.client,client);assert.equal(client.domains.movies.client,client);assert.equal(client.domains.live.client,client);
  assert.ok(await connection.createClient(connection.resolveConnection({...input,provider:'wplay-ott'})) instanceof WplayOTTProviderClient);
  assert.ok(await connection.createClient(connection.resolveConnection({...input,provider:'xtream',server:'https://fixture.example'})) instanceof ProviderClient);
});

test('connection preserves injected factory and existing web playback gates',async()=>{
  const calls=[],fixture={session:null},providerFactory=async options=>{calls.push(options);return fixture;};
  const connection=new OrquestradorConexaoWplay({providerFactory});
  const resolved=connection.resolveConnection(input);
  assert.equal(resolved.options.webPlayback,false);
  assert.equal(await connection.createClient(resolved),fixture);assert.equal(calls.length,1);
  assert.equal(calls[0].config.password,input.password);
  assert.equal(new OrquestradorConexaoWplay({allowPrivateUpstream:true}).resolveConnection(input).options.webPlayback,false);
});

test('connection scopes the Supabase gateway to native WPLAY authentication',async()=>{
  const calls=[],cloud={providerAuthenticationEnabled:true,authenticateWplay:async value=>{calls.push(value);return {payload:{code:0},cloudCollector:false};}};
  const connection=new OrquestradorConexaoWplay({cloud});
  const native=connection.resolveConnection(input),request={server:WPLAY_AUTH_URLS[1],form:'synthetic-only'};
  assert.deepEqual(await native.options.authenticate(request),{payload:{code:0},cloudCollector:false});assert.deepEqual(calls,[request]);
  assert.equal(connection.resolveConnection({...input,provider:'wplay-ott'}).options.authenticate,undefined);
  assert.equal(connection.resolveConnection({...input,provider:'xtream',server:'https://fixture.example'}).options.authenticate,undefined);
  assert.deepEqual(wplayProviderAuthenticationOptions('wplay',{...cloud,providerAuthenticationEnabled:false}),{});
});

test('connection validates adapter and server without accepting a native endpoint from input',()=>{
  const connection=new OrquestradorConexaoWplay();
  assert.throws(()=>connection.resolveConnection({...input,provider:'other'}),{code:'INVALID_CONNECTION',status:400});
  assert.throws(()=>connection.resolveConnection({...input,provider:'xtream'}),{code:'INVALID_CONNECTION',status:400});
  assert.equal(connection.resolveConnection({...input,server:'https://untrusted.example'}).config.server,WPLAY_AUTH_URLS[1]);
  assert.equal(connection.resolveConnection({...input,provider:'xtream'},{server:'https://configured.example'}).config.server,'https://configured.example');
});

test('configuration prefers explicit environment and reads only the injected local source otherwise',async()=>{
  const environment={IPTV_SERVER:'https://fixture.example',IPTV_USERNAME:'fixture',IPTV_PASSWORD:'synthetic'};
  assert.deepEqual(await configuredConnection({environment,read:()=>assert.fail('Environment does not read the local source.')}),{server:environment.IPTV_SERVER,username:'fixture',password:'synthetic'});
  const calls=[],location=new URL('file:///synthetic/connection.json');
  assert.deepEqual(await configuredConnection({environment:{},location,read:async(...args)=>{calls.push(args);return '{"server":"https://configured.example"}';}}),{server:'https://configured.example'});
  assert.deepEqual(calls,[[location,'utf8']]);
  assert.equal(await configuredConnection({environment:{},read:async()=>'{invalid'}),null);
});

test('cloud attachment bounds local wait while deduplicating the existing provisioning task',async()=>{
  let finish,count=0;const pending=new Promise(resolve=>{finish=resolve;});
  const runtime={attach:async()=>{count++;return pending;}},state={authGeneration:1,cloud:null};
  const session={connected:true,account:{status:'Active',libraryId:'synthetic-account',expiresAt:null}},client={authenticatedAt:1};
  const attach=createCloudAttachment(runtime,{budgetMs:1});
  // Keep this synthetic test alive while the connector deliberately unrefs its budget timer.
  const keepAlive=setInterval(()=>{},1000);
  try{
    const [one,two]=await Promise.all([attach(state,session,client),attach(state,session,client)]);
    assert.equal(one,null);assert.equal(two,null);assert.equal(count,1);
    finish(null);await pending;
  }finally{clearInterval(keepAlive);}
});

test('cloud attachment backs off failures but denial and a new generation bypass that cooldown',async()=>{
  let clock=1000,count=0;
  const runtime={attach:async()=>{count++;throw new Error('Synthetic unavailable');}};
  const attach=createCloudAttachment(runtime,{retryMs:30000,now:()=>clock}),state={authGeneration:1,cloud:null};
  const session={connected:true,account:{status:'Active',libraryId:'synthetic-account',expiresAt:null}},client={authenticatedAt:1};
  assert.equal(await attach(state,session,client),null);assert.equal(count,1);
  assert.equal(await attach(state,session,client),null);assert.equal(count,1);
  clock+=30000;assert.equal(await attach(state,session,client),null);assert.equal(count,2);
  state.authGeneration++;assert.equal(await attach(state,session,client),null);assert.equal(count,3);
  await assert.rejects(attach(state,{...session,account:{...session.account,status:'Expired'}},client),/Synthetic unavailable/);assert.equal(count,4);
});
