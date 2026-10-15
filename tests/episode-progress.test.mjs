import test from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeProgressStore, episodePlaybackProgress} from '../web/episode-progress.js';
import {renderSeriesPreview,episodeArtworkSources} from '../web/series-preview.js';

const item = {id:'series-12', kind:'series', name:'Série', poster:'/api/image?ref=private'};
const episode = (id, extra = {}) => ({id:String(id), season:1, number:Number(id) || 1, ...extra});
function fixture(options = {}) {
  const data = new Map(), writes = [];
  const store = new EpisodeProgressStore({read:(key, fallback)=>structuredClone(data.get(key) ?? fallback), save:(key, value)=>{writes.push(key);data.set(key, structuredClone(value));}, now:()=>1000, ...options});
  return {store, data, writes};
}

test('adult episodes never write, seed, expose or resume progress, even when the permission callback allows them', () => {
  const {store, writes} = fixture({canRemember:()=>true});store.setNamespace('account-a');
  const adult = {...item, isAdult:true}, entry = {item:adult, episode:episode(1), time:400, duration:1800, updated:20};
  assert.equal(store.save(entry), null);assert.equal(store.seed([entry], {namespace:'account-a'}), 0);
  assert.equal(store.read(adult, episode(1)), null);assert.deepEqual(store.list(adult), []);assert.equal(writes.length, 0);
  assert.equal(episodePlaybackProgress(adult, episode(1), entry), null);
  assert.equal(episodePlaybackProgress(item, episode(1), entry), null);
  assert.equal(episodePlaybackProgress(item, episode(1, {adult:true}), entry), null);
});

test('late category classification purges every legacy episode for that series and leaves safe series intact', () => {
  const {store, data} = fixture();store.setNamespace('account-a');
  const safe = {...item, id:'safe'};
  for (const id of ['1','2']) store.save({item, episode:episode(id), time:100, updated:10});
  store.save({item:safe, episode:episode(1), time:200, updated:20});
  assert.equal(store.reconcileCatalog({categories:[{id:'18', name:'Reservado', isAdult:true}], items:[{id:item.id, categoryIds:['18']}, safe]}, 'movies'), 0);
  assert.equal(store.reconcileCatalog({categories:[{id:'18', name:'Reservado', isAdult:true}], items:[{id:item.id, categoryIds:['18']}, safe]}, 'series'), 2);
  assert.equal(store.read(item, episode(1)), null);assert.equal(store.read(safe, episode(1)).time, 200);
  assert.deepEqual(data.get('orbit.episode-progress.v1.account-a').entries.map(record=>record.itemId), ['safe']);
  assert.equal(store.seed([{item, episode:episode(2), time:300, updated:30}], {namespace:'account-a'}), 0);
  assert.equal(store.reconcileCatalog({categories:[], items:[item,safe]}), 0, 'A later unmarked snapshot does not undo a positive classification in this account session.');
  store.setNamespace('account-b');assert.equal(store.save({item, episode:episode(1), time:150}).time, 150, 'Classification does not leak across account/provider namespaces.');
});

test('the account classification callback blocks old metadata, and an adult duplicate cannot enter through seed', () => {
  let blocked = false;
  const {store, data} = fixture({canRemember:()=>!blocked});store.setNamespace('account-a');
  store.save({item, episode:episode(1), time:300});blocked = true;
  assert.equal(store.read(item, episode(1)), null);assert.deepEqual(data.get('orbit.episode-progress.v1.account-a').entries, []);
  const other = fixture().store;other.setNamespace('account-a');
  const entry = {item, episode:episode(1), time:100, updated:10};
  assert.equal(other.seed([entry, {...entry,item:{...item,groupNames:['Adultos']}}], {namespace:'account-a'}), 0);
  assert.deepEqual(other.list(), []);
  assert.equal(episodePlaybackProgress({...item,categoryId:'a'}, episode(1), entry, {categories:[{id:'a',is_adult:true}]}), null);
});

test('a legacy positive flag on the progress envelope is removed before metadata normalization', () => {
  const {store,data} = fixture();
  data.set('orbit.episode-progress.v1.account-a',{version:1,namespace:'account-a',entries:[{itemId:item.id,episodeId:'1',time:100,duration:1800,updated:10,isAdult:true},{itemId:item.id,episodeId:'2',time:200,duration:1800,updated:20}]});
  store.setNamespace('account-a');assert.deepEqual(store.list(),[]);assert.deepEqual(data.get('orbit.episode-progress.v1.account-a').entries,[]);
  const entry={item,episode:episode(1),time:100,updated:30,adult:true};
  store.setNamespace('account-b');assert.equal(store.seed([entry],{namespace:'account-b'}),0);assert.equal(episodePlaybackProgress(item,episode(1),entry),null);
});

test('direct save and legacy episode flags cannot lose positive classification during destructuring', () => {
  const {store,data} = fixture();store.setNamespace('account-a');
  store.save({item,episode:episode(1),time:300});
  assert.equal(store.save({item,episode:episode(1),time:600,adult:true}),null);
  assert.equal(store.read(item,episode(1)),null);assert.deepEqual(data.get('orbit.episode-progress.v1.account-a').entries,[]);
  data.set('orbit.episode-progress.v1.account-b',{version:1,namespace:'account-b',entries:[
    {itemId:item.id,episodeId:'1',time:100,updated:10,episode:{id:'1',is_adult:true}},
    {itemId:item.id,episodeId:'2',time:200,updated:20},
    {itemId:'safe',episodeId:'1',time:150,updated:30}
  ]});
  store.setNamespace('account-b');assert.deepEqual(store.list().map(record=>record.itemId),['safe']);
  assert.deepEqual(data.get('orbit.episode-progress.v1.account-b').entries.map(record=>record.itemId),['safe']);
  assert.equal(store.save({item:{...item,id:'safe'},episode:episode(1),time:180}).time,180);
});

test('each episode retains its own position after switching and reloading the same account', () => {
  const {store, data} = fixture();store.setNamespace('wplay:account-a');
  store.save({item, episode:episode('ep:one'), time:120, duration:1800, updated:10});
  store.save({item, episode:episode('ep:two'), time:650, duration:2400, updated:20});
  assert.equal(store.read(item, episode('ep:one')).time, 120);
  assert.equal(store.read(item, episode('ep:two')).time, 650);
  store.setNamespace('wplay:account-b');assert.equal(store.list().length, 0);
  store.setNamespace('wplay:account-a');assert.equal(store.list(item).length, 2);
  assert.equal(store.read(item, episode('ep:one')).time, 120);
  const persisted = JSON.stringify([...data.values()]);
  for (const secret of ['Série', 'private', 'poster', '/api/image']) assert.equal(persisted.includes(secret), false);
});

test('account and provider namespaces are isolated, including a mismatched storage envelope', () => {
  const {store, data} = fixture();store.setNamespace('wplay:one');
  store.save({item, episode:episode(1), time:90, duration:1000});
  const stored = structuredClone(data.get('orbit.episode-progress.v1.wplay:one'));
  data.set('orbit.episode-progress.v1.wplay:two', stored);
  for (const namespace of ['wplay:two', 'xtream:one', 'wplay-ott:one']) {
    store.setNamespace(namespace);assert.equal(store.read(item, episode(1)), null);
  }
  store.setNamespace('wplay:one');assert.equal(store.read(item, episode(1)).time, 90);
});

test('missing account identity uses memory only and every null reset starts a clean session', () => {
  const {store, writes} = fixture();
  assert.equal(store.setNamespace(null), false);
  store.save({item, episode:episode(1), time:120, duration:1800});
  assert.equal(store.read(item, episode(1)).time, 120);assert.equal(writes.length, 0);
  store.setNamespace(null);assert.equal(store.read(item, episode(1)), null);
  store.setNamespace('https://private.example/user');
  store.save({item, episode:episode(1), time:300});assert.equal(writes.length, 0);
});

test('account-scoped seed imports absent exact episodes and never overwrites saved progress', () => {
  const {store} = fixture();store.setNamespace('account-a');
  const entry = {item, episode:episode(1), time:400, duration:1800, updated:20};
  assert.equal(store.seed([entry]), 0);
  assert.equal(store.seed([entry], {namespace:'account-b'}), 0);
  assert.equal(store.seed(new Map([['series:12', entry]]), {namespace:'account-a'}), 1);
  store.save({...entry, time:600, updated:30});
  assert.equal(store.seed([{...entry, time:10, updated:100}], {namespace:'account-a'}), 0);
  assert.equal(store.read(item, episode(1)).time, 600);
  store.setNamespace(null);assert.equal(store.seed([entry], {namespace:'account-a'}), 0);
});

test('migration selects the latest duplicate episode snapshot without mixing series identities', () => {
  const {store} = fixture();store.setNamespace('account-a');
  const entry = {item, episode:episode(1), time:100, duration:1800, updated:20};
  const other = {item:{...item, id:'another-series'}, episode:episode(1), time:900, duration:2400, updated:40};
  assert.equal(store.seed([entry, {...entry, time:500, updated:30}, {...entry, time:10, updated:10}, other], {namespace:'account-a'}), 2);
  assert.equal(store.read(item, episode(1)).time, 500);
  assert.equal(store.read(other.item, episode(1)).time, 900);
});

test('malformed identities and times cannot create records and stale updates cannot lower newer progress', () => {
  const {store} = fixture();store.setNamespace('account-a');
  for (const time of [NaN, Infinity, -1, '120', null, undefined, true]) assert.equal(store.save({item, episode:episode(1), time}), null);
  for (const id of ['', 'https://provider.example/1', '../escape', 'token?value', 'x'.repeat(129)]) assert.equal(store.save({item, episode:episode(id), time:20}), null);
  assert.equal(store.save({item:{...item, kind:'movie'}, episode:episode(1), time:20}), null);
  store.save({item, episode:episode(1), time:600, duration:1800, updated:100});
  store.save({item, episode:episode(1), time:20, duration:NaN, updated:90});
  assert.equal(store.read(item, episode(1)).time, 600);
  store.save({item, episode:episode(1), time:650, duration:Infinity, updated:110});
  assert.equal(store.read(item, episode(1)).duration, 1800);
  const copy = store.read(item, episode(1));copy.time = 1;
  const listed = store.list();listed[0].time = 2;
  assert.equal(store.read(item, episode(1)).time, 650);
});

test('bounded persistence keeps newest episode updates and storage failures preserve live memory', () => {
  const {store} = fixture({limit:2});store.setNamespace('account-a');
  for (const [id, updated] of [['1', 30], ['2', 10], ['3', 20]]) store.save({item, episode:episode(id), time:20, updated});
  assert.deepEqual(store.list().map(record=>record.episodeId), ['1', '3']);
  const blocked = new EpisodeProgressStore({read:()=>{throw new Error('blocked');}, save:()=>{throw new Error('full');}});
  blocked.setNamespace('account-a');
  assert.equal(blocked.save({item, episode:episode('opaque-uuid'), time:50, duration:600}).time, 50);
  assert.equal(blocked.read(item, episode('opaque-uuid')).time, 50);
});

test('each row uses measured total first, explicit episode duration second and never a series runtime', () => {
  const ep = episode(1, {durationSeconds:1800}), base = {...item, durationSeconds:99999};
  const entry = {itemId:item.id, episodeId:'1', time:150, duration:2400, updated:1};
  assert.deepEqual(episodePlaybackProgress(base, ep, entry), {time:150, duration:2400, percent:6.25, completed:false, state:'in-progress', label:'Continuar assistindo', elapsed:'2:30', total:'40:00'});
  assert.equal(episodePlaybackProgress(base, ep, null).total, '30:00');
  assert.equal(episodePlaybackProgress(base, ep, null).elapsed, '0:00');
  for (const duration of [45, '45', '00:45', 'unknown', null]) assert.equal(episodePlaybackProgress(base, episode(1, {duration}), null).duration, null);
  assert.equal(episodePlaybackProgress(base, episode(1, {duration:'00:42:30'}), null).duration, 2550);
  assert.equal(episodePlaybackProgress(base, episode(1, {duration:'1 h 2 min'}), null).duration, 3720);
});

test('completion is bounded, can follow ended without a total and resets when an episode is replayed', () => {
  const {store} = fixture();store.setNamespace('account-a');
  const record = store.save({item, episode:episode(1), time:999, duration:600});
  assert.equal(record.time, 600);assert.equal(record.completed, true);
  store.save({item, episode:episode(1), time:100, duration:600, updated:1001});
  assert.equal(store.read(item, episode(1)).completed, false);
  assert.equal(episodePlaybackProgress(item, episode(1), {itemId:item.id, episodeId:'1', time:570, duration:600, updated:1}).label, 'Assistido');
  assert.equal(episodePlaybackProgress(item, episode(1), {itemId:item.id, episodeId:'1', time:300, duration:null, completed:true, updated:1}).label, 'Assistido');
});

test('history compatibility matches exact series and episode without copying another episode position', () => {
  const legacy = {item, episode:episode(2), time:600, duration:1800};
  assert.equal(episodePlaybackProgress(item, episode(2), legacy).elapsed, '10:00');
  assert.equal(episodePlaybackProgress(item, episode(1), legacy).time, 0);
  assert.equal(episodePlaybackProgress({...item, id:'another'}, episode(2), legacy).time, 0);
  const unknown=episodePlaybackProgress(item,episode(2),{...legacy,duration:0});
  assert.equal(unknown.elapsed,'10:00');assert.equal(unknown.percent,null);assert.equal(unknown.total,'');
});

class Element {
  constructor(tag) {this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.events={};this.classList={toggle:()=>{}};}
  append(...children) {this.children.push(...children);}
  setAttribute(key,value) {this.attributes[key]=value;}
  addEventListener(key,handler) {this.events[key]=handler;}
}
function descendants(element, className) {return element.children.flatMap(child=>child instanceof Element?[...(child.className===className?[child]:[]), ...descendants(child,className)]:[]);}

test('series rows render independent positions, an unstarted real total and accessible bars without requests', t => {
  const previous = globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const series={id:'12',kind:'series',name:'Série',seasons:[{number:1,episodes:[episode(1,{durationSeconds:1800}),episode(2,{durationSeconds:2400}),episode(3,{durationSeconds:1200}),episode(4,{duration:'45'})]}]};
  let section,played;
  const tools={begin:()=>({showcase:new Element('div'),summary:new Element('div')}),genre:()=>{},actions:()=>{},information:()=>{},icon:()=>new Element('svg'),finish:(_,sections)=>{section=sections[0];}};
  const records=new Map([['1',{itemId:'12',episodeId:'1',time:150,duration:1800,updated:1}],['2',{itemId:'12',episodeId:'2',time:2300,duration:2400,updated:2}]]);
  renderSeriesPreview(tools,series,{readEpisodeProgress:(_,episode)=>records.get(episode.id),onSeason:()=>{},onEpisode:episode=>{played=episode.id;}});
  const rows=descendants(section,'episode-button');
  assert.deepEqual(rows.map(row=>row.dataset.progressState),['in-progress','completed','unwatched','unwatched']);
  assert.deepEqual(descendants(section,'episode-progress-time').map(node=>node.textContent),['2:30 / 30:00','38:20 / 40:00','0:00 / 20:00','Duração não informada']);
  const bars=descendants(section,'episode-progress-bar');assert.equal(bars.length,3);
  assert.equal(bars[0].value,150);assert.equal(bars[0].max,1800);assert.equal(bars[2].value,0);
  assert.match(rows[0].attributes['aria-label'],/Continuar assistindo/);
  assert.equal(bars[0].attributes['aria-valuetext'],'2:30 assistidos de 30:00');
  rows[0].events.click();assert.equal(played,'1');
});

test('episode artwork prefers actual registered episode metadata and truthfully labels the series fallback',t=>{
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  const series={id:'12',kind:'series',name:'Series',backdrop:'/api/image?ref=backdrop',poster:'/api/image?ref=poster',seasons:[{number:1,episodes:[episode(1,{thumbnail:'/api/image?ref=ep1'}),episode(2)]}]};
  assert.deepEqual(episodeArtworkSources({thumbnail:'https://unregistered.example/still.jpg'},series),[{url:series.backdrop,kind:'series'},{url:series.poster,kind:'series'}]);
  let section;const tools={begin:()=>({showcase:new Element('div'),summary:new Element('div')}),genre:()=>{},actions:()=>{},information:()=>{},icon:()=>new Element('svg'),finish:(_,sections)=>section=sections[0]};
  renderSeriesPreview(tools,series,{onSeason:()=>{},onEpisode:()=>{}});
  const thumbs=descendants(section,'episode-thumbnail'),images=descendants(section,'episode-thumbnail-image'),captions=descendants(section,'episode-thumbnail-caption');
  assert.equal(images[0].src,'/api/image?ref=ep1');assert.equal(images[0].loading,'lazy');assert.equal(thumbs[0].dataset.artworkKind,'episode');
  assert.equal(images[1].src,series.backdrop);assert.equal(thumbs[1].dataset.artworkKind,'series');assert.equal(captions[1].textContent,'Imagem da série');
  images[0].events.error();assert.equal(images[0].src,series.backdrop);assert.equal(captions[0].textContent,'Imagem da série');
  images[0].events.error();images[0].events.error();assert.equal(images[0].hidden,true);assert.equal(thumbs[0].dataset.artworkKind,'placeholder');
});
