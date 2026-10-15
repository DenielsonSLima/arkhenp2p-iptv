import test from 'node:test';
import assert from 'node:assert/strict';
import {detailPlaybackProgress, renderDetailProgress} from '../web/detail-progress.js';

const movie = {kind:'movie', id:'42', name:'Filme', durationSeconds:7200};
const history = (item, extra={}) => ({item, time:2712, duration:7290, ...extra});

test('adult titles and previously adult history never reveal a saved position in details', () => {
  assert.equal(detailPlaybackProgress({...movie,isAdult:true},history(movie)),null);
  assert.equal(detailPlaybackProgress(movie,history({...movie,isAdult:true})),null);
  assert.equal(detailPlaybackProgress(movie,history(movie,{isAdult:true})),null);
  assert.equal(detailPlaybackProgress({...movie,categoryId:'private'},history(movie),{categories:[{id:'private',name:'Reservado',is_adult:true}]}),null);
  assert.equal(detailPlaybackProgress({...movie,groupNames:['Adultos']},history(movie)),null);
  const series={kind:'series',id:'s',seasons:[{number:1,episodes:[{id:'e',adult:true}]}]};
  assert.equal(detailPlaybackProgress(series,history(series,{episode:{id:'e'}})),null);
});

test('detail progress uses the measured playback duration and exact saved position', () => {
  const entry = history(movie), before = structuredClone(entry);
  const progress = detailPlaybackProgress(movie, entry);
  assert.equal(progress.elapsed, '45:12');
  assert.equal(progress.total, '2:01:30');
  assert.equal(progress.time, 2712);
  assert.equal(progress.duration, 7290);
  assert.equal(progress.percent, 2712/7290*100);
  assert.deepEqual(entry, before);
});

test('movie metadata supplies an explicit fallback total without fabricating missing duration', () => {
  const entry = history(movie, {duration:0});
  assert.equal(detailPlaybackProgress(movie, entry).total, '2:00:00');
  const unknown = detailPlaybackProgress({...movie, durationSeconds:null, duration:'120'}, entry);
  assert.equal(unknown.elapsed, '45:12');
  assert.equal(unknown.duration, null);
  assert.equal(unknown.total, '');
  assert.equal(unknown.percent, null);
});

test('absent, invalid, live and mismatched history never produces a false progress bar', () => {
  assert.equal(detailPlaybackProgress(movie, null), null);
  assert.equal(detailPlaybackProgress(movie, history({...movie, id:'99'})), null);
  assert.equal(detailPlaybackProgress(movie, history({...movie, kind:'series'})), null);
  assert.equal(detailPlaybackProgress({...movie,id:undefined}, history({...movie,id:undefined})), null);
  for (const time of [0, -10, null, undefined, '', 'invalid', true, {}, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(detailPlaybackProgress(movie, history(movie, {time})), null, String(time));
  }
  const channel = {...movie, kind:'live'};
  assert.equal(detailPlaybackProgress(channel, history(channel)), null);
});

test('series progress belongs to the actual saved episode and never to the series runtime', () => {
  const series = {kind:'series', id:'12', durationSeconds:99999, seasons:[{number:2, episodes:[{id:'203', season:2, number:3, durationSeconds:1800}]}]};
  const entry = history(series, {time:630, duration:2400, episode:{id:'203', season:99, number:99}});
  const progress = detailPlaybackProgress(series, entry);
  assert.equal(progress.episodeLabel, 'T2 · E3');
  assert.equal(progress.elapsed, '10:30');
  assert.equal(progress.total, '40:00');
  assert.equal(detailPlaybackProgress(series, {...entry, duration:0}).duration, null);
  assert.equal(detailPlaybackProgress(series, {...entry, episode:{id:'999'}}), null);
  assert.equal(detailPlaybackProgress(series, {...entry, episode:null}), null);
});

test('a saved position beyond the known duration is bounded to the real total', () => {
  const progress = detailPlaybackProgress(movie, history(movie, {time:8000}));
  assert.equal(progress.time, 7290);
  assert.equal(progress.percent, 100);
  assert.equal(progress.elapsed, progress.total);
});

class Element {
  constructor(tag) {this.tagName=tag;this.children=[];this.attributes={};}
  append(...children) {for (const child of children) {child.parent=this;this.children.push(child);}}
  querySelector(selector) {const className=selector.split('.').at(-1);return this.children.find(child=>child.className===className)||null;}
  insertBefore(child, next) {child.parent=this;this.children.splice(this.children.indexOf(next),0,child);}
  remove() {this.parent?.children.splice(this.parent.children.indexOf(this),1);}
  setAttribute(name, value) {this.attributes[name]=value;}
}

test('detail progress sits before the synopsis and keeps accessible values on async refresh', t => {
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{if (previous===undefined) delete globalThis.document;else globalThis.document=previous;});
  const summary=new Element('div'),actions=new Element('div'),synopsis=new Element('p');
  actions.className='detail-actions';synopsis.className='detail-plot';summary.append(actions,synopsis);
  const first=renderDetailProgress(summary,movie,history(movie));
  assert.deepEqual(summary.children,[actions,first,synopsis]);
  const progress=first.children.find(child=>child.tagName==='progress');
  assert.equal(progress.max,7290);assert.equal(progress.value,2712);
  assert.equal(progress.attributes['aria-label'],'Progresso do filme');
  assert.equal(progress.attributes['aria-valuetext'],'45:12 assistidos de 2:01:30 no total');
  const refreshed=renderDetailProgress(summary,{...movie,durationSeconds:7500},history(movie,{duration:0}));
  assert.deepEqual(summary.children,[actions,refreshed,synopsis]);
  assert.equal(refreshed.children.find(child=>child.tagName==='progress').max,7500);
  renderDetailProgress(summary,movie,null);
  assert.deepEqual(summary.children,[actions,synopsis]);
});
