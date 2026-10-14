import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WplayProviderClient, wplayAuthForm, wplayServiceURL } from '../lib/wplay-provider.mjs';

const username='usuário+fixture',password='senha & fixture';

test('native catalog items retain all supplied genres before opening details',()=>{
  const client=new WplayProviderClient({username,password});
  const raw={chid:123,name:{init:'Matchbox'},tags:[{_id:1,name:{init:'Filmes/Ação'}},{_id:2,name:{init:'Filmes/Comédia'}},{_id:3,name:{init:'Filmes/Aventura'}},{_id:4,name:{init:'Filmes/Lançamentos'}},null]};
  const item=client.normalizeItems([raw],'movie').items[0];
  assert.equal(item.genre,'Filmes/Ação, Filmes/Comédia, Filmes/Aventura, Filmes/Lançamentos');
  assert.equal(client.normalizeItems([{chid:456,name:'Sem gêneros'}],'movie').items[0].genre,'');
});

test('native cover uses portrait artwork while transparent title art stays out of cards',()=>{
  const client=new WplayProviderClient({username,password});
  const raw={chid:123,name:{init:'Notícias'},image_logo:'https://art.example/title.png',image_backdrop:'https://art.example/backdrop.jpg',logo:{image:{big:'https://art.example/poster.jpg',small:'https://art.example/title-small.png',full:'https://art.example/wide.jpg'}}};
  for(const kind of ['movie','series','live']){
    const item=client.normalizeItems([raw],kind).items[0];
    assert.equal(client.images.get(new URL(item.poster,'http://local').searchParams.get('ref')),'https://art.example/poster.jpg');
    assert.equal(client.images.get(new URL(item.backdrop,'http://local').searchParams.get('ref')),'https://art.example/backdrop.jpg');
  }
  const item=client.normalizeItems([{...raw,image_backdrop:null}],'movie').items[0];
  assert.equal(client.images.get(new URL(item.backdrop,'http://local').searchParams.get('ref')),'https://art.example/wide.jpg');
});
async function fixture({auth={code:0},redirect=false,media=null,holdMedia=false}={}) {
  const requests=[];let origin,mediaEntered;const mediaRequested=new Promise(resolve=>{mediaEntered=resolve;});
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString(),url=new URL(req.url,origin);
    requests.push({path:url.pathname,query:url.search,method:req.method,body,headers:req.headers});
    if(url.pathname==='/api/v2/auth'){
      if(redirect){res.writeHead(302,{Location:origin+'/credential-collector'}).end();return;}
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...auth,...(auth.code===0?{user:{EndTime:1999999999,user_name:username},keys:{peer_id:'private-peer',session_key:'private-session'},service:{token:'private+token',ch_url:origin+'/channels',vod_url:origin+'/videos',enabledLive:true,enabledVoD:true}}:{})}));return;
    }
    if(url.pathname==='/channels'){
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify([{chid:101,name:{init:'Canal ao vivo'},logo:{image:{big:origin+'/art?token=private+token'}},tags:[{id:1,name:{init:'TV'}}],sources:[{id:501,address:'tvbus://private-stream',subTitle:'HD'}]},{chid:102,name:{init:'Canal HTTP'},tags:[{id:1,name:{init:'TV'}}],sources:[{id:502,address:origin+'/live.m3u8'}]}]));return;
    }
    if(url.pathname==='/videos'){
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify([{chid:201,name:{init:'Filme &amp; ação'},image_logo:origin+'/art',year:2025,rating:8.1,description:'História do filme',tags:[{id:2,name:{init:'Filmes'}}],sources:[{id:601,address:origin+'/film.mp4',subTitle:'Dublado',duration:5400}]},{chid:301,name:{init:'Série'},tags:[{id:3,name:{init:'Séries'}}],sources:[{id:701,address:origin+'/episode.mp4',subTitle:'S01E01',duration:2400},{id:702,address:'bts://private-native',subTitle:'T02-E03',duration:2600}]}]));return;
    }
    if(url.pathname==='/film.mp4'&&media){
      mediaEntered();if(holdMedia)return;
      const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
      if(!range){res.writeHead(400).end();return;}
      const first=Number(range[1]),last=Math.min(Number(range[2]),media.length-1);
      res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':`bytes ${first}-${last}/${media.length}`}).end(media.subarray(first,last+1));return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const client=new WplayProviderClient({server:origin+'/api/v2/auth',username,password,device:{deviceID:'real-fixture-android-id',buildModel:'Fixture TV',sysVersion:'12'}},{allowPrivate:true});
  return {client,requests,origin,mediaRequested,close:async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
}

test('WPlay uses the recovered POST form and Android User-Agent without exposing session secrets',async()=>{
  const mock=await fixture();
  try {
    const session=await mock.client.connect(),request=mock.requests[0],form=new URLSearchParams(request.body);
    assert.equal(request.method,'POST');assert.equal(request.path,'/api/v2/auth');assert.equal(request.headers['content-type'],'application/x-www-form-urlencoded');assert.equal(Number(request.headers['content-length']),Buffer.byteLength(request.body));
    assert.equal(form.get('username'),username+'@wareztv.io');assert.equal(form.get('password'),password);assert.equal(form.get('from'),'ap');assert.equal(form.get('packageName'),'io.wareztv.android.one');assert.equal(form.get('appName'),'WPlay');assert.equal(form.get('appVersion'),'1190');
    assert.equal(request.headers['user-agent'],'Apache-HttpClient/Null (WPlay 11.9.0d; Android 12; Fixture TV; real-fixture-android-id)');assert.equal(session.connected,true);
    const exposed=JSON.stringify(session);for(const value of [username,password,'private+token','private-peer','private-session',mock.origin])assert.ok(!exposed.includes(value));
  } finally {await mock.close();}
});

test('catalogs use response-provided token URLs and share one VOD request for movies and series',async()=>{
  const mock=await fixture();
  try {
    const [live,movies,series]=await Promise.all(['live','movies','series'].map(type=>mock.client.catalog(type)));
    assert.equal(live.items.length,2);assert.equal(movies.items.length,1);assert.equal(series.items.length,1);assert.equal(movies.items[0].name,'Filme & ação');assert.equal(series.items[0].kind,'series');
    assert.equal(mock.requests.filter(request=>request.path==='/videos').length,1);
    for(const request of mock.requests.filter(request=>['/channels','/videos'].includes(request.path))){assert.equal(request.method,'GET');assert.equal(request.query,'?t=private+token');}
    const exposed=JSON.stringify([live,movies,series]);for(const value of [username,password,'private+token','private-stream',mock.origin])assert.ok(!exposed.includes(value));
    assert.match(live.items[0].poster,/^\/api\/image\?ref=/);assert.ok(mock.client.images.size>0);
  } finally {await mock.close();}
});

test('series sources use the APK season regex and only registered HTTP streams play',async()=>{
  const mock=await fixture();
  try {
    const details=await mock.client.details('series','301');assert.deepEqual(details.seasons.map(season=>[season.number,season.episodes[0].number]),[[1,1],[2,3]]);
    assert.equal((await mock.client.playbackURL('series','701')).href,mock.origin+'/episode.mp4');
    assert.equal((await mock.client.playbackURL('movie','201')).href,mock.origin+'/film.mp4');
    await assert.rejects(mock.client.playbackURL('series','702'),error=>error.code==='WPLAY_NATIVE_ENGINE_REQUIRED'&&error.status===501);
    await assert.rejects(mock.client.playbackURL('live','101'),error=>error.code==='WPLAY_NATIVE_ENGINE_REQUIRED');
    await assert.rejects(mock.client.playbackURL('movie','999'),/não disponível/);
  } finally {await mock.close();}
});

test('login does not accept absent success codes or forward credentials through redirects',async()=>{
  for(const options of [{auth:{}},{auth:{code:null}},{auth:{code:-1}},{redirect:true}]){
    const mock=await fixture(options);
    try {await assert.rejects(mock.client.connect());assert.equal(mock.client.session,null);assert.equal(mock.requests.length,1);assert.ok(!mock.requests.some(request=>request.path==='/credential-collector'));}
    finally {await mock.close();}
  }
});

test('device fallback and token URL transformations match the recovered code',()=>{
  const form=new URLSearchParams(wplayAuthForm({username,password}));assert.equal(form.get('deviceID'),'did');assert.equal(form.get('operateMode'),'0');assert.equal(form.get('buildModel'),'');
  assert.equal(new URLSearchParams(wplayAuthForm({username:'  existing@example.com  ',password:'  secret  '})).get('username'),'existing@example.com');assert.equal(new URLSearchParams(wplayAuthForm({username:'  user  ',password:'  secret  '})).get('password'),'secret');
  assert.equal(wplayServiceURL('https://example.com/catalog','a+b'),'https://example.com/catalog?t=a+b');assert.equal(wplayServiceURL('https://example.com/catalog?category=1','a+b'),'https://example.com/catalog?category=1&t=a+b');
  assert.equal(wplayServiceURL('https://example.com/catalog?t=existing','replacement'),'https://example.com/catalog?t=existing');
});

test('account-not-found remains distinct from expired or transport errors and never tries another server',async()=>{
  const mock=await fixture({auth:{code:-11,result:'no such account'}});
  try {
    await assert.rejects(mock.client.connect(),error=>error.code==='WPLAY_ACCOUNT_NOT_FOUND'&&error.status===401&&error.authCode===-11&&error.provider==='wplay'&&/Conta não encontrada/.test(error.message));
    assert.equal(mock.requests.length,1);
    const defaults=new WplayProviderClient({username,password});assert.deepEqual(defaults.authURLs,['https://auth1.wareztv.io/api/v2/auth']);
  } finally {await mock.close();}
});

function durationMovie(seconds) {
  const box=(type,payload)=>{const header=Buffer.alloc(8);header.writeUInt32BE(8+payload.length);header.write(type,4,'ascii');return Buffer.concat([header,payload]);};
  const header=Buffer.alloc(20);header.writeUInt32BE(1000,12);header.writeUInt32BE(seconds*1000,16);
  return Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',box('mvhd',header)),box('mdat',Buffer.alloc(70_000))]);
}

test('native movie runtime is opt-in, measured with Android headers, and never inferred from an ambiguous source duration',async()=>{
  const mock=await fixture({media:durationMovie(5700)});
  try{
    const basic=await mock.client.details('movie','201');
    assert.equal(basic.durationSeconds,null);assert.equal(basic.year,'2025');assert.equal(basic.rating,8.1);
    assert.equal(mock.requests.filter(request=>request.path==='/film.mp4').length,0);
    const measured=await mock.client.details('movie','201',{probeDuration:true});
    assert.equal(measured.durationSeconds,5700);assert.equal(measured.duration,'1 h 35 min');
    const mediaRequests=mock.requests.filter(request=>request.path==='/film.mp4');
    assert.equal(mediaRequests.length,1);assert.equal(mediaRequests[0].headers.range,'bytes=0-65535');assert.equal(mediaRequests[0].headers['user-agent'],mock.client.userAgent);
    assert.equal((await mock.client.details('movie','201',{probeDuration:true})).durationSeconds,5700);
    assert.equal(mock.requests.filter(request=>request.path==='/film.mp4').length,1);
    assert.equal((await mock.client.details('movie','201')).durationSeconds,null,'A measured preview runtime does not change the basic catalog metadata.');
    const series=await mock.client.details('series','301',{probeDuration:true});assert.equal(series.durationSeconds,null);
    assert.equal(mock.requests.filter(request=>request.path==='/episode.mp4').length,0);
  }finally{await mock.close();}
});

test('starting playback aborts a pending native movie duration probe without turning metadata into an error',async()=>{
  const mock=await fixture({media:durationMovie(5700),holdMedia:true});
  try{
    const preview=mock.client.details('movie','201',{probeDuration:true});await mock.mediaRequested;
    mock.client.beginPlayback('movie:201');
    assert.equal((await preview).durationSeconds,null);assert.equal(mock.client.durationProbe,null);
    const before=mock.requests.filter(request=>request.path==='/film.mp4').length;
    assert.equal((await mock.client.details('movie','201',{probeDuration:true})).durationSeconds,null);
    assert.equal(mock.requests.filter(request=>request.path==='/film.mp4').length,before);
  }finally{mock.client.stopPlayback();await mock.close();}
});
