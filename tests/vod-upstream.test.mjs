import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestVODUpstream} from '../lib/vod-upstream.mjs';
import {WplayPlaybackProviderClient} from '../lib/wplay/conexao/reproducao.mjs';
import {readBody} from '../lib/upstream.mjs';

function reply(status){return {status,body:{destroyed:false,destroy(){this.destroyed=true;}}};}

test('VOD retries one unavailable response with identical source and range, releasing its body',async()=>{
  for(const status of [502,503,504]) {
    const rejected=reply(status),success=reply(206),calls=[];
    const source=new URL('https://media.example/registered.mp4?ticket=fixture');
    const options={headers:{Range:'bytes=1000-', 'User-Agent':'fixture'}};
    const result=await requestVODUpstream(source,options,async(value,settings)=>{
      calls.push({value,settings});return calls.length===1?rejected:success;
    });
    assert.equal(result,success);assert.equal(rejected.body.destroyed,true);
    assert.equal(success.body.destroyed,false);assert.equal(calls.length,2);
    assert.ok(calls.every(call=>call.value===source&&call.settings===options));
  }
});

test('VOD recovers a transient connection failure but never loops or hides permanent failures',async()=>{
  const reset=Object.assign(new Error('Connection reset'),{code:'ECONNRESET'});
  let attempts=0;
  assert.equal((await requestVODUpstream('https://media.example/movie.mp4',{},async()=>{
    if(++attempts===1)throw reset;return reply(206);
  })).status,206);
  attempts=0;
  await assert.rejects(requestVODUpstream('https://media.example/movie.mp4',{},async()=>{
    attempts++;throw reset;
  }),error=>error===reset);
  assert.equal(attempts,2);
  for(const status of [200,206,400,401,403,404,416]) {
    attempts=0;const response=reply(status);
    assert.equal(await requestVODUpstream('https://media.example/movie.mp4',{},async()=>{attempts++;return response;}),response);
    assert.equal(attempts,1);assert.equal(response.body.destroyed,false);
  }
  attempts=0;const permanent=Object.assign(new Error('Denied'),{code:'CERT_HAS_EXPIRED'});
  await assert.rejects(requestVODUpstream('https://media.example/movie.mp4',{},async()=>{attempts++;throw permanent;}),error=>error===permanent);
  assert.equal(attempts,1);
});

test('cancelling VOD while waiting prevents the second upstream request',async()=>{
  const controller=new AbortController();let attempts=0;
  const response=reply(503);
  const pending=requestVODUpstream('https://media.example/movie.mp4',{signal:controller.signal},async()=>{
    attempts++;setTimeout(()=>controller.abort(),10);return response;
  });
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(attempts,1);assert.equal(response.body.destroyed,true);
});

test('provider applies retry only to VOD, while live HTTP retains its single request',async t=>{
  const calls=[];let attempts=0;
  const server=http.createServer((req,res)=>{
    calls.push(req.headers.range);attempts++;
    if(attempts===1){res.writeHead(502).end();return;}
    res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 0-3/4'}).end('test');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=new WplayPlaybackProviderClient({username:'fixture',password:'fixture'},{allowPrivate:true});
  const source=`http://127.0.0.1:${server.address().port}/movie.mp4`;
  client.beginPlayback('series:1');
  const vod=await client.upstreamRequest(source,{headers:{Range:'bytes=0-3'}});
  assert.equal(vod.status,206);assert.equal((await readBody(vod)).toString(),'test');
  assert.deepEqual(calls,['bytes=0-3','bytes=0-3']);
  attempts=0;client.beginPlayback('live:1');
  const live=await client.upstreamRequest(source,{headers:{Range:'bytes=0-3'}});
  assert.equal(live.status,502);live.body.destroy();assert.equal(attempts,1);
  await client.stopPlayback();
});
