import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WplayOTTProviderClient, WPLAY_OTT_RPC } from '../lib/wplay/ott/provedor.mjs';
import { encodeRPC, decodeRPC } from '../lib/wplay/ott/rpc.mjs';
import { requestUpstream, readBody } from '../lib/upstream.mjs';

async function fixture({member=false,artworkFailure=false,legacyUnavailable=false,legacyRejected=false,emptyCatalog=false,emptyRows=false,moviesOnly=false}={}) {
  const requests=[];let origin;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString(),url=new URL(req.url,origin);
    const data=body?decodeRPC(JSON.parse(body)).data:undefined;
    requests.push({url:url.href,path:url.pathname,method:req.method,data,headers:req.headers});
    let result;
    const id=url.pathname.split('/').pop();
    if(id===WPLAY_OTT_RPC.login)result=member?{authenticated:true,accessToken:'private-access-token',refreshToken:'private-refresh-token'}:{authenticated:false,message:'Usuário inválido'};
    else if(id===WPLAY_OTT_RPC.legacyLogin){
      if(legacyUnavailable)result={authenticated:false,message:'O servidor da lista está indisponível no momento.'};
      else if(legacyRejected)result={authenticated:false,message:'Usuário ou senha inválidos.'};
      else {res.setHeader('Set-Cookie','private_session=private-cookie; Path=/; HttpOnly');result={authenticated:true,message:'ok'};}
    }
    else if(id===WPLAY_OTT_RPC.catalog){
      if(member?req.headers.authorization!=='Bearer private-access-token':req.headers.cookie!=='private_session=private-cookie'){res.writeHead(401).end();return;}
      result={rows:[{title:'TV ao vivo',kind:'Canal',items:[{id:'live:uuid',title:'Canal',kind:'Canal',image:'/art?key=private-image-key',playbackUrl:'/live/raw.m3u8?token=private-stream',liveVariants:[{quality:'HD',playbackUrl:'/live/raw.m3u8?token=private-stream'}]}]},{title:'Cinema',kind:'Filme',items:[{id:'movie:uuid',title:'Filme',kind:'Filme',meta:'2026 • Drama',image:'/art',playbackUrl:'/film/raw.mp4?token=private-film'}]},{title:'Séries',kind:'Série',items:[{id:'series:uuid',title:'Série',kind:'Série',playbackUrl:null}]}]};
      if(emptyCatalog)result={rows:[]};
      if(emptyRows)for(const row of result.rows)row.items=[];
      if(moviesOnly)result.rows=result.rows.filter(row=>row.kind==='Filme');
    } else if(id===WPLAY_OTT_RPC.artwork){if(artworkFailure){res.writeHead(502).end();return;}result={artwork:{image:'/poster?key=private-artwork',backdrop:'/backdrop',description:'Enredo',score:80,year:2026}};}
    else if(id===WPLAY_OTT_RPC.episodes)result={episodes:[{id:'episode:uuid',title:'Piloto',season:1,episode:1,thumbnail:'/episode-still?key=private-episode-image',playbackUrl:'/episode/raw.mp4?token=private-episode'}]};
    else if(id===WPLAY_OTT_RPC.logout)result={success:true};
    else if(url.pathname==='/live/raw.m3u8'&&req.method==='POST'){res.writeHead(204).end();return;}
    else if(url.pathname==='/live/raw.m3u8'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}).end('#EXTM3U\n#EXTINF:4,\nsegment.ts\n');return;}
    else {res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'application/json','x-tss-serialized':'true'}).end(encodeRPC({result}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const client=new WplayOTTProviderClient({server:origin,username:'fixture-user',password:'fixture-secret'},{allowPrivate:true});
  return {client,requests,origin,setLegacyUnavailable:value=>{legacyUnavailable=value;},setEmptyCatalog:value=>{emptyCatalog=value;},setEmptyRows:value=>{emptyRows=value;},close:async()=>{await client.stopPlayback();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
}

test('OTT RPC safely round-trips Seroval strings, primitive values and references',()=>{
  const shared={value:'quote" slash\\ newline\n <script> \u2028'},value={data:{identifier:'ação+fixture',password:'&secret'},array:[true,false,null,undefined,0,-2.5],one:shared,two:shared};
  const decoded=decodeRPC(JSON.parse(encodeRPC(value)));assert.deepEqual(decoded,value);assert.equal(decoded.one,decoded.two);
  const polluted=decodeRPC({t:10,i:0,p:{k:['__proto__'],v:[{t:1,s:'safe'}]},o:0});assert.equal(Object.getPrototypeOf(polluted),Object.prototype);assert.equal(polluted.__proto__,'safe');
});

test('OTT follows the observed general login then legacy cookie login and shares the real catalog',async()=>{
  const mock=await fixture();try {
    const session=await mock.client.connect();assert.equal(session.connected,true);assert.equal(session.account.expiresAt,null);
    assert.equal(mock.requests[0].method,'POST');assert.deepEqual(mock.requests[0].data,{identifier:'fixture-user',password:'fixture-secret'});assert.deepEqual(mock.requests[1].data,{username:'fixture-user',password:'fixture-secret'});
    const catalogs=await Promise.all(['live','movies','series'].map(type=>mock.client.catalog(type)));
    assert.deepEqual(catalogs.map(catalog=>catalog.items.length),[1,1,1]);assert.equal(mock.requests.filter(request=>request.path.endsWith(WPLAY_OTT_RPC.catalog)).length,1);
    assert.equal(catalogs[0].items[0].name,'Canal HD');assert.match(catalogs[0].items[0].id,/^\d{1,12}$/);assert.match(catalogs[0].items[0].poster,/^\/api\/image\?ref=/);assert.equal(catalogs[1].items[0].year,'2026');
    const exposed=JSON.stringify([session,...catalogs]);for(const privateValue of ['fixture-secret','private-cookie','private-image-key','private-stream','private-film','live:uuid','movie:uuid',mock.origin])assert.ok(!exposed.includes(privateValue));
    const headers=mock.client.upstreamHeaders(mock.origin+'/art');assert.equal(headers.Cookie,'private_session=private-cookie');const external=mock.client.upstreamHeaders('https://cdn.example.com/segment.ts');assert.equal(external.Cookie,undefined);assert.equal(external.Authorization,undefined);
  } finally {await mock.close();}
});

test('member sessions send the observed Bearer header without running legacy auth',async()=>{
  const mock=await fixture({member:true});try {const result=await mock.client.catalog('movies');assert.equal(result.items.length,1);assert.equal(mock.requests.length,2);assert.equal(mock.requests[1].headers.authorization,'Bearer private-access-token');assert.ok(!JSON.stringify(mock.client.session).includes('private-access-token'));}finally{await mock.close();}
});

test('an unavailable legacy list is a recoverable service failure rather than rejected credentials',async()=>{
  const mock=await fixture({legacyUnavailable:true});try {
    await assert.rejects(mock.client.connect(),error=>error.code==='OTT_SERVICE_UNAVAILABLE'&&error.status===503&&!/senha/i.test(error.message));
    assert.equal(mock.client.session,null);assert.equal(mock.client.connecting,null);
    mock.setLegacyUnavailable(false);assert.equal((await mock.client.connect()).connected,true);
  }finally{await mock.close();}
  const rejected=await fixture({legacyRejected:true});try {
    await assert.rejects(rejected.client.connect(),error=>error.code==='AUTH_REJECTED'&&error.status===401);
  }finally{await rejected.close();}
});

test('an empty catalog is rejected without caching it and can recover on the next request',async()=>{
  const mock=await fixture({emptyCatalog:true});try {
    await assert.rejects(mock.client.catalog('live'),error=>error.code==='OTT_EMPTY_CATALOG'&&error.status===503);
    assert.equal(mock.client.cache.has('ott:catalog'),false);assert.equal(mock.client.cache.has('catalog:live'),false);
    mock.setEmptyCatalog(false);const previous=await mock.client.catalog('live');assert.equal(previous.items.length,1);
    const id=previous.items[0].id,source=mock.client.rawItems.get('live:'+id);
    mock.setEmptyCatalog(true);mock.client.invalidateCatalog('live');
    await assert.rejects(mock.client.catalog('live'),error=>error.code==='OTT_EMPTY_CATALOG');
    assert.equal(previous.items.length,1);assert.equal(mock.client.rawItems.get('live:'+id),source);
    mock.setEmptyCatalog(false);assert.equal((await mock.client.catalog('live')).items[0].id,id);
    assert.equal(mock.requests.filter(request=>request.path.endsWith(WPLAY_OTT_RPC.catalog)).length,4);
  }finally{await mock.close();}
});

test('catalog rows without any items are retried while a missing single content kind remains valid',async()=>{
  const empty=await fixture({emptyRows:true});try {
    await assert.rejects(empty.client.catalog('movies'),error=>error.code==='OTT_EMPTY_CATALOG'&&error.status===503);
    assert.equal(empty.client.cache.has('ott:catalog'),false);assert.equal(empty.client.cache.has('catalog:movies'),false);
    empty.setEmptyRows(false);assert.equal((await empty.client.catalog('movies')).items.length,1);
    assert.equal(empty.requests.filter(request=>request.path.endsWith(WPLAY_OTT_RPC.catalog)).length,2);
  }finally{await empty.close();}
  const movies=await fixture({moviesOnly:true});try {
    assert.equal((await movies.client.catalog('live')).items.length,0);
    assert.equal((await movies.client.catalog('movies')).items.length,1);
    assert.equal(movies.requests.filter(request=>request.path.endsWith(WPLAY_OTT_RPC.catalog)).length,1);
  }finally{await movies.close();}
});

test('OTT details register only actual episode URLs, resolving relative artwork and playback',async()=>{
  const mock=await fixture();try {
    const series=(await mock.client.catalog('series')).items[0],details=await mock.client.details('series',series.id),episode=details.seasons[0].episodes[0];
    assert.equal(details.plot,'Enredo');assert.equal(details.rating,8);assert.equal(details.seasons[0].number,1);assert.equal(episode.title,'Piloto');assert.equal((await mock.client.playbackURL('series',episode.id)).href,mock.origin+'/episode/raw.mp4?token=private-episode');
    assert.match(episode.thumbnail,/^\/api\/image\?ref=/);assert.ok(!JSON.stringify(details).includes('private-episode-image'));
    const movie=(await mock.client.catalog('movies')).items[0];assert.equal((await mock.client.playbackURL('movie',movie.id)).href,mock.origin+'/film/raw.mp4?token=private-film');
    assert.ok(!JSON.stringify(details).includes('private-episode'));await assert.rejects(mock.client.playbackURL('series','999'),error=>error.code==='EPISODE_NOT_REGISTERED');
  } finally {await mock.close();}
});

test('OTT live URLs retain their source token and stable screen/generation, and stop before switching to VOD',async()=>{
  const mock=await fixture();try {
    const live=(await mock.client.catalog('live')).items[0],first=await mock.client.playbackURL('live',live.id),second=await mock.client.playbackURL('live',live.id);
    assert.equal(first.href,second.href);assert.equal(first.searchParams.get('token'),'private-stream');assert.equal(first.searchParams.get('gen'),'1');assert.ok(first.searchParams.get('sid'));
    const movie=(await mock.client.catalog('movies')).items[0];await mock.client.playbackURL('movie',movie.id);
    const stop=mock.requests.find(request=>request.method==='POST'&&request.path==='/live/raw.m3u8');assert.ok(stop);const url=new URL(stop.url);assert.equal(url.searchParams.get('stop'),'1');assert.equal(url.searchParams.get('sid'),first.searchParams.get('sid'));assert.equal(url.searchParams.get('gen'),'1');assert.equal(stop.headers.cookie,'private_session=private-cookie');
  } finally {await mock.close();}
});

test('upstream redirects retain cookies on their origin and drop credentials before crossing to another origin',async()=>{
  const headers=[];let firstOrigin,secondOrigin;
  const second=http.createServer((req,res)=>{headers.push(req.headers);res.writeHead(200).end('ok');});
  const first=http.createServer((req,res)=>{if(req.url==='/start'){res.writeHead(302,{Location:'/same'}).end();return;}headers.push(req.headers);res.writeHead(302,{Location:secondOrigin+'/end'}).end();});
  await Promise.all([new Promise(resolve=>first.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>second.listen(0,'127.0.0.1',resolve))]);firstOrigin=`http://127.0.0.1:${first.address().port}`;secondOrigin=`http://127.0.0.1:${second.address().port}`;
  try {const response=await requestUpstream(firstOrigin+'/start',{allowPrivate:true,headers:{Cookie:'private=value',Authorization:'Bearer private'}});assert.equal((await readBody(response)).toString(),'ok');assert.equal(headers[0].cookie,'private=value');assert.equal(headers[0].authorization,'Bearer private');assert.equal(headers[1].cookie,undefined);assert.equal(headers[1].authorization,undefined);}finally{first.closeAllConnections?.();second.closeAllConnections?.();await Promise.all([new Promise(resolve=>first.close(resolve)),new Promise(resolve=>second.close(resolve))]);}
});

test('the app-server playbackURL then beginPlayback sequence keeps the newly selected live stream running',async()=>{
  const mock=await fixture();try {
    const live=(await mock.client.catalog('live')).items[0],intent=++mock.client.playbackGeneration;
    const source=await mock.client.playbackURL('live',live.id);assert.equal(mock.client.playbackGeneration,intent);
    const playback=mock.client.beginPlayback('live:'+live.id);assert.equal(playback.controller.signal.aborted,false);
    const response=await requestUpstream(source,{allowPrivate:true,headers:mock.client.upstreamHeaders(source)});assert.equal(response.status,200);assert.match((await readBody(response)).toString(),/^#EXTM3U/);
    assert.equal(mock.requests.filter(request=>request.path==='/live/raw.m3u8'&&request.method==='POST').length,0);
    await mock.client.stopPlayback();assert.equal(playback.controller.signal.aborted,true);
    const stops=mock.requests.filter(request=>request.path==='/live/raw.m3u8'&&request.method==='POST');assert.equal(stops.length,1);assert.equal(new URL(stops[0].url).searchParams.get('gen'),source.searchParams.get('gen'));assert.equal(new URL(stops[0].url).searchParams.get('sid'),source.searchParams.get('sid'));
  } finally {await mock.close();}
});

test('optional artwork failure does not prevent fetching and playing the series episodes',async()=>{
  const mock=await fixture({artworkFailure:true});try {
    const series=(await mock.client.catalog('series')).items[0],details=await mock.client.details('series',series.id);
    assert.equal(details.name,'Série');assert.equal(details.seasons[0].episodes[0].title,'Piloto');assert.equal((await mock.client.playbackURL('series',details.seasons[0].episodes[0].id)).pathname,'/episode/raw.mp4');
  } finally {await mock.close();}
});
