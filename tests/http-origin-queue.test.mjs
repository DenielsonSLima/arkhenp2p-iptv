import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

test('six pending same-origin HTTP requests queue a player request until one connection is available',async t=>{
  const pending=new Map();let images=0,entered,playEntered=false;
  const ready=new Promise(resolve=>{entered=resolve;});
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/synthetic-artwork/')){
      pending.set(req.url,()=>{if(res.writableEnded)return;res.writeHead(503,{'Content-Length':'0'});res.end();});
      if(++images===6)entered();return;
    }
    playEntered=true;res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const agent=new http.Agent({keepAlive:true,maxSockets:6});
  t.after(async()=>{for(const release of pending.values())release();agent.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const read=path=>new Promise((resolve,reject)=>{
    http.get({hostname:'127.0.0.1',port:server.address().port,path,agent},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));}).once('error',reject);
  });
  const artwork=Array.from({length:6},(_,index)=>read('/synthetic-artwork/'+index));await ready;
  const started=performance.now(),play=read('/synthetic-playlist');
  assert.equal(Object.values(agent.requests).flat().length,1);assert.equal(playEntered,false);
  await delay(30);assert.equal(playEntered,false,'No media handler runs while all six transport connections are occupied.');
  pending.get('/synthetic-artwork/0')();assert.equal(await play,200);assert.equal(playEntered,true);
  t.diagnostic(JSON.stringify({synthetic:true,occupiedConnections:6,queuedMediaRequests:1,queueDurationMs:Math.round(performance.now()-started)}));
  for(const [path,release]of pending)if(path!=='/synthetic-artwork/0')release();
  assert.deepEqual(await Promise.all(artwork),[503,503,503,503,503,503]);
});
