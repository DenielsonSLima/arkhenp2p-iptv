import test from 'node:test';
import assert from 'node:assert/strict';
import {HomeChannelShelf} from '../web/inicio/lista-canais/visualizacao.js';

class Element extends EventTarget {
  constructor(tag, document) {
    super();Object.assign(this, {tagName:tag, ownerDocument:document, nodeType:1, children:[], parentNode:null,
      dataset:{}, attributes:{}, style:{}, className:'', textContent:'', hidden:false});
    this.classList = {
      add:(...names) => {this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ');},
      toggle:(name, active) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (active) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      },
      contains:name => this.className.split(/\s+/).includes(name),
    };
  }
  get isConnected() {return Boolean(this.connected || this.parentNode?.isConnected);}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  append(...nodes) {for (const node of nodes) this.insertBefore(node, null);}
  prepend(node) {this.insertBefore(node, this.children[0] || null);}
  insertBefore(node, before) {
    if (node === before) return;
    node.remove();const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);node.parentNode = this;
  }
  replaceChildren(...nodes) {for (const child of [...this.children]) child.remove();this.append(...nodes);}
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  getBoundingClientRect() {return {width:240, height:120, top:0, bottom:120};}
}

const item = (id, extra = {}) => ({id:String(id), kind:'live', name:'Canal '+id, isAdult:false, ...extra});
const entry = (id, reason = 'recent', extra = {}) => ({item:item(id, extra), reason});
function fixture(t, options = {}) {
  const document = new EventTarget();document.hidden = false;
  document.createElement = tag => new Element(tag, document);
  const environment = new EventTarget();Object.assign(environment, {document, innerHeight:900});
  const shelf = new HomeChannelShelf({environment, getScope:() => 'fixture-account', ...options});
  t.after(() => shelf.dispose());return shelf;
}
const fallback = () => ({mostWatchedId:null, featuredId:'1', items:[entry(1, 'default-globo', {name:'Globo SP'}), ...[2,3,4,5].map(id => entry(id))]});
const guide = (title = 'Programa atual', extra = {}) => ({window:{
  current:{title, startLabel:'13:00', endLabel:'14:00'}, next:{title:'Próximo programa', startLabel:'14:00', endLabel:'15:00'},
}, progressPercent:37, ...extra});

test('Home keeps five logo cards with the server-selected highlight and never creates a video', t => {
  let videos=0;
  const shelf=fixture(t,{createLogo:()=>new Element('img'),preview:{playbackURL:()=>{throw new Error('Home must not open media');}}});
  const create=shelf.document.createElement;shelf.document.createElement=tag=>{if(tag==='video')videos++;return create(tag);};
  const dto=fallback();dto.items.push(entry(6));shelf.render(null,dto);shelf.sync();
  assert.deepEqual(shelf.getItems().map(value=>value.id),['1','2','3','4','5']);
  const featured=shelf.records.get('1');
  assert.equal(featured.card.classList.contains('is-featured'),true);
  assert.equal(featured.card.classList.contains('is-most-watched'),false);
  assert.equal(featured.logo.children[0].tagName,'img');
  assert.equal(shelf.video,undefined);assert.equal(videos,0);
  const copy=shelf.getItems();copy.pop();assert.equal(shelf.getItems().length,5);
});

test('weekly winner preserves its highlight while recent-only data is never promoted locally', t => {
  const shelf=fixture(t);shelf.render(null,{mostWatchedId:'8',items:[entry(8,'most-watched'),entry(2)]});
  const record=shelf.records.get('8');
  assert.match(record.reason.textContent,/7 dias/);assert.equal(record.card.classList.contains('is-most-watched'),true);
  shelf.render(null,{mostWatchedId:'8',items:[entry(8,'most-watched'),entry(2)]});assert.equal(shelf.records.get('8'),record);
  shelf.render(null,{featuredId:null,mostWatchedId:null,items:[entry(3,'recent',{name:'Globo SP'})]});
  assert.equal(shelf.featuredId,null);assert.equal(shelf.records.get('3').card.classList.contains('is-featured'),false);
});

test('only the current programme is shown; guide changes preserve card nodes', t => {
  const shelf=fixture(t);shelf.render(null,fallback());const cards=[...shelf.row.children];
  shelf.updatePrograms(new Map([['1',guide()]]));const record=shelf.records.get('1');
  assert.equal(record.programNodes.current.title.textContent,'Programa atual');
  assert.equal(record.programNodes.current.time.textContent,'13:00 — 14:00');
  assert.equal(record.programNodes.next,undefined);assert.equal(record.programRows.children.length,1);
  assert.equal(record.programProgress.value,37);
  shelf.updatePrograms({'1':guide('Programa atualizado',{progressPercent:62})});
  assert.equal(record.programProgress.value,62);assert.deepEqual(shelf.row.children,cards);
});

test('missing current programme is explicit, and refresh failure keeps readable cards with compact feedback', t => {
  const shelf=fixture(t);shelf.render(null,fallback());const record=shelf.records.get('1');
  shelf.updatePrograms({}, {loading:true});assert.equal(record.program.dataset.state,'loading');
  shelf.updatePrograms({}, {error:new Error('fixture')});assert.equal(record.program.dataset.state,'error');
  shelf.updatePrograms({'1':guide()}, {error:new Error('fixture')});
  assert.equal(record.program.dataset.state,'ready');assert.equal(record.program.dataset.stale,'true');
  shelf.updatePrograms({'1':{window:{current:null,next:{title:'Next only',startLabel:'18:00'}}}});
  assert.equal(record.programRows.hidden,true);assert.equal(record.programProgress.hidden,true);
  assert.equal(record.program.dataset.state,'unavailable');
  shelf.render(null,fallback(),{error:{status:503}});
  assert.equal(shelf.row.hidden,false);assert.equal(shelf.feedback.hidden,false);
  assert.equal(shelf.feedback.classList.contains('is-compact'),true);
  assert.match(shelf.feedbackCopy.textContent,/Não foi possível atualizar/);
  shelf.render(null,fallback(),{loading:false});assert.equal(shelf.feedback.hidden,true);
});

test('click keeps fullscreen activation synchronous and hands the existing stop barrier to the player', t => {
  const calls = [], shelf = fixture(t, {onWatch:(channel, options) => calls.push(['watch', channel.id, options])});
  shelf.render(null, fallback());const stopped = Promise.resolve();
  shelf.pause = reason => {calls.push(['pause', reason]);return stopped;};
  shelf.records.get('4').play.dispatchEvent(new Event('click'));
  assert.deepEqual(calls[0], ['pause', 'watch']);assert.equal(calls[1][0], 'watch');
  assert.equal(calls[1][1], '4');assert.equal(calls[1][2].fullscreen, true);assert.equal(calls[1][2].stopped, stopped);
});

test('visibility and adult filters remove cards without filling or ranking other channels', t => {
  const shelf = fixture(t, {isVisible:channel => channel.id !== '3'}), dto = fallback();
  dto.items[1].item.isAdult = true;shelf.render(null, dto);
  assert.deepEqual(shelf.getItems().map(value => value.id), ['1','4','5']);
  shelf.reset();assert.deepEqual(shelf.getItems(), []);assert.equal(shelf.featuredId, null);
});
