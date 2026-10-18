import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {ProviderClient, ProviderError} from '../lib/provider.mjs';

test('games are authenticated, route validated options, preserve unsupported-provider absence and hide private upstream errors', async t => {
  const calls=[];
  t.mock.method(WplayPlaybackProviderClient.prototype,'connect',async function(){this.session={connected:true,account:{provider:'wplay'}};return this.session;});
  t.mock.method(ProviderClient.prototype,'connect',async function(){this.session={connected:true,account:{provider:'xtream'}};return this.session;});
  let fail=false;
  t.mock.method(WplayPlaybackProviderClient.prototype,'games',async function(options){calls.push(options);if(fail)throw new ProviderError('Não foi possível carregar os jogos do serviço agora. Tente novamente.','WPLAY_GAMES_UNAVAILABLE',502);return {available:true,date:options.date,timeZone:options.timeZone,games:[]};});
  const app=createApp({connection:{server:'https://fixture.example'}});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base=`http://127.0.0.1:${app.address().port}`,route='/api/games?date=2026-10-14&timezone=America%2FMaceio&lang=pt';
  assert.equal((await fetch(base+route)).status,401);
  const login=async provider=>{
    const response=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({provider,username:'fixture',password:'private-password'})});
    assert.equal(response.status,200);await response.json();return {Cookie:response.headers.get('set-cookie').split(';')[0]};
  };
  const headers=await login('wplay');
  const answer=await fetch(base+route,{headers});assert.equal(answer.status,200);
  assert.deepEqual(await answer.json(),{available:true,date:'2026-10-14',timeZone:'America/Maceio',games:[]});
  assert.deepEqual(calls,[{date:'2026-10-14',timeZone:'America/Maceio',lang:'pt'}]);
  const invalid=await fetch(base+'/api/games?date=2026-02-30',{headers});assert.equal(invalid.status,400);await invalid.json();
  assert.equal(calls.length,1);
  fail=true;const failure=await fetch(base+route,{headers});assert.equal(failure.status,502);assert.equal((await failure.json()).code,'WPLAY_GAMES_UNAVAILABLE');
  const unsupportedHeaders=await login('xtream'),unsupported=await fetch(base+route,{headers:unsupportedHeaders});
  const absent=await unsupported.json();assert.equal(absent.available,false);assert.deepEqual(absent.games,[]);
  const logout=await fetch(base+'/api/logout',{method:'POST',headers:{...headers,Origin:base},body:'{}'});await logout.json();
  assert.equal((await fetch(base+route,{headers})).status,401);
});
