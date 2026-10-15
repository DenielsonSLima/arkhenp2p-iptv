import test from 'node:test';
import assert from 'node:assert/strict';
import { WplayProviderClient } from '../lib/wplay-provider.mjs';
import { nativeEpisodeID } from '../lib/wplay-vod.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

function fixture({invalidPage=false}={}) {
  const calls=[],client=new WplayProviderClient({username:'fixture',password:'private-fixture'});
  const category=(id,name,extra={})=>({_id:id,type:110,name:{init:name},category_id:id+500,url:`https://catalog.example/category/${id}?view=small`,...extra});
  const movie=(id=101)=>({chid:id,name:{init:'Filme de teste'},tags:[{_id:50,name:{init:'Lançamentos'}}],year:2026,image_logo:'https://art.example/poster.jpg',sources:[{_id:601,address:'https://video.example/summary.mp4'}]});
  const series={chid:201,name:{init:'Série de teste'},sources:[{_id:701,subTitle:'S01E001',address:'https://video.example/summary-episode.mp4',duration:120}]};
  client.requestJSON=async(rawURL,options={})=>{
    const url=new URL(rawURL);calls.push({url,method:options.method||'GET'});
    if(url.pathname==='/api/v2/auth')return {code:0,user:{end_time:'2030-11-13T00:00:00Z'},service:{token:'secret+token',vod_tag_url:'https://catalog.example/tags',vod_search_url:'https://catalog.example/search',vod_url:'https://catalog.example/do-not-fetch',enabledVoD:true}};
    if(url.pathname==='/tags')return [
      {group_id:49,group_name:{init:'Filmes'},items:[category(49,'Top 10'),category(50,'Lançamentos'),category(80,'Ação'),category(81,'Aventura'),category(82,'Drama')]},
      {group_id:1009,group_name:'Séries',items:[category(1009,'Top 10'),category(1010,'Lançamentos')]},
      {group_id:12,group_name:'Netflix',items:[category(1201,'Netflix Filmes'),category(1202,'Netflix Séries')]},
      {group_id:18,group_name:'+18',restrictedAccess:true,items:[category(1801,'Lançamentos adultos')]}
    ];
    if(url.pathname.startsWith('/category/')){
      if(invalidPage)return {error:'provider temporarily unavailable'};
      const id=Number(url.pathname.split('/').pop()),page=Number(url.searchParams.get('page'));
      if(page>2)return [];
      if(id===1009||id===1010||id===1202)return [series];
      if(page===2)return [movie(102)];
      return [movie()];
    }
    if(url.pathname==='/search/@101')return {...movie(),description:'Sinopse detalhada',duration:'1h 32min',sources:[{_id:601,address:'https://video.example/full-film.mp4',duration:120}]};
    if(url.pathname==='/search/@201')return {...series,sources:[
      {_id:701,subTitle:'S01E001',address:'https://video.example/full-episode.mp4',duration:120,thumbnail:'https://art.example/episode-701.jpg'},
      {_id:702,subTitle:'S01E001',address:'https://video.example/duplicate-quality.mp4'},
      {_id:'opaque-episode-id',subTitle:'S02E003',address:'https://video.example/season-two.mp4',duration:'00:42:00'}
    ]};
    if(url.pathname==='/search/@999')return {...movie(999),sources:[{_id:999,address:'https://video.example/history.mp4'}]};
    throw new Error('Unexpected fixture request: '+url.pathname);
  };
  return {client,calls};
}

test('native VOD follows registered category URLs with bounded initial pages and no bare VOD request',async()=>{
  const {client,calls}=fixture();
  const [movies,series]=await Promise.all([client.catalog('movies'),client.catalog('series')]);
  assert.equal(calls.filter(call=>call.url.pathname==='/tags').length,1);
  assert.equal(calls.filter(call=>call.url.pathname.startsWith('/category/')).length,7);
  assert.ok(!calls.some(call=>call.url.pathname==='/do-not-fetch'||call.url.pathname==='/category/1801'));
  assert.deepEqual(movies.categories.slice(0,2).map(category=>category.id),['49','50']);
  assert.ok(!movies.categories.some(category=>category.id==='1009'));
  assert.ok(series.categories.some(category=>category.id==='1202'));
  assert.ok(!series.categories.some(category=>category.id==='1201'));
  assert.equal(movies.items.length,1);assert.equal(series.items.length,1);
  assert.equal(series.items[0].kind,'series');
  assert.deepEqual(new Set(movies.items[0].categoryIds),new Set(['49','50','80','81']));
  assert.deepEqual(movies.pagination.byCategory['82'],{nextPage:1,hasMore:true,loaded:false});
  for(const call of calls.filter(call=>call.url.pathname.startsWith('/category/')))assert.equal(call.url.search,'?view=small&t=secret+token&page=1');
  const exposed=JSON.stringify([movies,series]);
  for(const secret of ['secret+token','catalog.example','video.example','private-fixture'])assert.ok(!exposed.includes(secret));
});

test('native page snapshots merge titles and only mark completion on an empty successful page',async()=>{
  const {client,calls}=fixture();await client.catalog('movies');
  const page2=await client.catalogPage('movies','50',2);
  assert.deepEqual(page2.items.map(item=>item.id),['101','102']);
  assert.deepEqual(page2.pagination.byCategory['50'],{nextPage:3,hasMore:true,loaded:true});
  const page3=await client.catalogPage('movies','50',3);
  assert.deepEqual(page3.pagination.byCategory['50'],{nextPage:4,hasMore:false,loaded:true});
  const before=calls.length;await client.catalogPage('movies','50',4);assert.equal(calls.length,before);
  await assert.rejects(client.catalogPage('movies','50',0),error=>error.code==='WPLAY_PAGE_INVALID');
  await assert.rejects(client.catalogPage('movies','82',5),error=>error.code==='WPLAY_PAGE_INVALID');
  await assert.rejects(client.catalogPage('movies','99999',1),error=>error.code==='WPLAY_CATEGORY_INVALID');
  await assert.rejects(client.catalogPage('movies','1009',1),error=>error.code==='WPLAY_CATEGORY_INVALID');
});

test('failed native pages do not claim success or cache an empty catalog',async()=>{
  const {client}=fixture({invalidPage:true});
  await assert.rejects(client.catalog('movies'),error=>error.code==='WPLAY_INVALID_CATALOG');
  assert.equal(client.nativeVOD.pages.size,0);
  assert.equal(client.nativeVOD.initializing.has('movies'),false);
});

test('native details use SEARCH /@chid and playback uses hydrated sources after later page loads',async()=>{
  const {client,calls}=fixture();await client.catalog('movies');
  const details=await client.details('movie','101');
  assert.equal(details.plot,'Sinopse detalhada');assert.equal(details.durationSeconds,5520);
  const detailCall=calls.find(call=>call.url.pathname==='/search/@101');assert.equal(detailCall.url.search,'?t=secret+token');
  await client.catalogPage('movies','82',1);
  assert.equal((await client.playbackURL('movie','101')).href,'https://video.example/full-film.mp4');
  assert.equal(calls.filter(call=>call.url.pathname==='/search/@101').length,1);
  // Recent history may refer to a title outside the first four category pages.
  assert.equal((await client.details('movie','999')).id,'999');
});

test('native episode IDs handle numeric _id and opaque IDs, deduplicate quality variants, and preserve unknown duration',async()=>{
  const {client}=fixture();const details=await client.details('series','201');
  assert.deepEqual(details.seasons.map(season=>[season.number,season.episodes.length]),[[1,1],[2,1]]);
  assert.equal(details.seasons[0].episodes[0].id,'701');assert.equal(details.seasons[0].episodes[0].number,1);
  assert.match(details.seasons[0].episodes[0].thumbnail,/^\/api\/image\?ref=/);assert.equal(client.images.get(new URL(details.seasons[0].episodes[0].thumbnail,'http://local').searchParams.get('ref')),'https://art.example/episode-701.jpg');
  assert.equal(details.seasons[0].episodes[0].durationSeconds,null);
  const episode=details.seasons[1].episodes[0];assert.match(episode.id,/^\d{1,12}$/);assert.equal(episode.durationSeconds,2520);
  assert.equal(episode.id,nativeEpisodeID('201',{_id:'opaque-episode-id'}));
  assert.notEqual(episode.id,nativeEpisodeID('other-title',{_id:'opaque-episode-id'}));
  assert.equal((await client.playbackURL('series','701')).href,'https://video.example/full-episode.mp4');
  assert.equal((await client.playbackURL('series',episode.id)).href,'https://video.example/season-two.mp4');
  assert.ok(!JSON.stringify(details).includes('opaque-episode-id'));
});

test('native empty detail means title unavailable and is never cached as usable content',async()=>{
  const {client}=fixture(),request=client.requestJSON;
  let missing=true,calls=0;
  client.requestJSON=async(url,options)=>{
    if(new URL(url).pathname==='/search/@201'){
      calls++;if(missing)return {};
    }
    return request(url,options);
  };
  for(let attempt=0;attempt<2;attempt++)
    await assert.rejects(client.details('series','201'),error=>error.code==='WPLAY_TITLE_NOT_FOUND'&&error.status===404);
  assert.equal(calls,2);
  assert.equal(client.rawItems.has('series:201'),false);
  assert.equal(client.nativeVOD.items.series.size,0);
  assert.equal(client.episodes.size,0);
  missing=false;
  const detail=await client.details('series','201');
  assert.equal(detail.id,'201');assert.equal(detail.seasons.length,2);
});

test('native malformed or mismatched details remain upstream errors',async()=>{
  for(const payload of [null,[],{error:'Unavailable'}, {chid:202,name:{init:'Different title'},sources:[]}]) {
    const {client}=fixture(),request=client.requestJSON;
    client.requestJSON=(url,options)=>new URL(url).pathname==='/search/@201'?Promise.resolve(payload):request(url,options);
    await assert.rejects(client.details('series','201'),error=>error.code==='WPLAY_INVALID_DETAILS'&&error.status===502);
    assert.equal(client.rawItems.has('series:201'),false);
  }
});

test('native catalog refreshes retain one instance and independent movie/series pagination',async()=>{
  const {client,calls}=fixture();await Promise.all([client.catalog('movies'),client.catalog('series')]);
  const native=client.nativeVOD;
  await client.catalogPage('series','1010',2);
  const seriesCalls=()=>calls.filter(call=>call.url.pathname==='/category/1010').length,before=seriesCalls();
  client.invalidateCatalog('movies');await client.catalog('movies');
  assert.equal(client.nativeVOD,native);
  const series=await client.catalog('series');
  assert.deepEqual(series.pagination.byCategory['1010'],{nextPage:3,hasMore:true,loaded:true});
  assert.equal(seriesCalls(),before);

  client.invalidateCatalog('movies');const moviesRequest=client.catalog('movies');
  client.invalidateCatalog('series');const seriesRequest=client.catalog('series');
  const [moviesRenewed,seriesRenewed]=await Promise.all([moviesRequest,seriesRequest]);
  assert.equal(client.nativeVOD,native);
  assert.equal(moviesRenewed.items.length,1);assert.equal(seriesRenewed.items.length,1);
  const [moviesPage2,seriesPage2]=await Promise.all([client.catalogPage('movies','50',2),client.catalogPage('series','1010',2)]);
  assert.equal(moviesPage2.pagination.byCategory['50'].nextPage,3);
  assert.equal(seriesPage2.pagination.byCategory['1010'].nextPage,3);
  assert.equal(calls.filter(call=>call.url.pathname==='/tags').length,3);
});

test('refresh discovers new categories while obsolete tags cannot replace the current registration',async()=>{
  const {client}=fixture(),entered=deferred(),release=deferred(),request=client.requestJSON;
  let first=true;
  client.requestJSON=async(url,options)=>{
    const payload=await request(url,options);
    if(new URL(url).pathname==='/tags'){
      if(first){first=false;entered.resolve();await release.promise;return payload;}
      return [...payload,{group_name:'Filmes',items:[{_id:83,name:'Nova categoria',url:'https://catalog.example/category/83'}]}];
    }
    return payload;
  };
  const oldCatalog=client.catalog('movies');await entered.promise;
  client.invalidateCatalog('movies');const current=await client.catalog('movies');
  assert.ok(current.categories.some(category=>category.id==='83'));
  release.resolve();
  assert.ok((await oldCatalog).categories.some(category=>category.id==='83'));
  assert.ok(client.nativeVOD.categories.has('83'));
});

test('a page response started before refresh cannot restore stale titles or advance new pagination',async()=>{
  const {client}=fixture();await client.catalog('movies');
  const entered=deferred(),release=deferred(),request=client.requestJSON;
  client.requestJSON=async(url,options)=>{
    const payload=await request(url,options),parsed=new URL(url);
    if(parsed.pathname==='/category/50'&&parsed.searchParams.get('page')==='2'){
      entered.resolve();await release.promise;return payload.map(item=>({...item,name:{init:'Título antigo'}}));
    }
    return payload;
  };
  const oldPage=client.catalogPage('movies','50',2);await entered.promise;
  client.invalidateCatalog('movies');const renewed=await client.catalog('movies');
  assert.deepEqual(renewed.items.map(item=>item.id),['101']);
  release.resolve();const oldResponse=await oldPage;
  for(const snapshot of [oldResponse,await client.catalog('movies')]){
    assert.deepEqual(snapshot.items.map(item=>item.id),['101']);
    assert.deepEqual(snapshot.pagination.byCategory['50'],{nextPage:2,hasMore:true,loaded:true});
  }
  assert.equal(client.rawItems.has('movie:102'),false);
});

test('a rejected pre-refresh initialization cannot remove or reject the renewed initialization',async()=>{
  const {client}=fixture(),entered=deferred(),release=deferred(),request=client.requestJSON;
  let held=0,hold=true;
  client.requestJSON=async(url,options)=>{
    const payload=await request(url,options);
    if(hold&&new URL(url).pathname.startsWith('/category/')){
      if(++held===4)entered.resolve();await release.promise;
    }
    return payload;
  };
  const oldCatalog=client.catalog('movies');await entered.promise;
  hold=false;client.invalidateCatalog('movies');const renewed=await client.catalog('movies');
  const initialization=client.nativeVOD.initializing.get('movies');
  release.reject(new Error('Obsolete provider request failed.'));
  assert.deepEqual(await oldCatalog,renewed);
  assert.equal(client.nativeVOD.initializing.get('movies'),initialization);
});

test('a detail response started before refresh cannot overwrite renewed metadata or playback sources',async()=>{
  const {client}=fixture();await client.catalog('movies');
  const entered=deferred(),release=deferred(),request=client.requestJSON;let hold=true;
  client.requestJSON=async(url,options)=>{
    const payload=await request(url,options);
    if(hold&&new URL(url).pathname==='/search/@101'){
      hold=false;entered.resolve();await release.promise;
      return {...payload,name:{init:'Detalhes antigos'},sources:[{_id:601,address:'https://video.example/stale.mp4'}]};
    }
    return payload;
  };
  const oldDetails=client.details('movie','101');await entered.promise;
  client.invalidateCatalog('movies');await client.catalog('movies');
  const renewed=await client.details('movie','101');release.resolve();
  assert.deepEqual(await oldDetails,renewed);
  assert.equal((await client.playbackURL('movie','101')).href,'https://video.example/full-film.mp4');
  assert.equal(client.rawItems.get('movie:101').name.init,'Filme de teste');
});
