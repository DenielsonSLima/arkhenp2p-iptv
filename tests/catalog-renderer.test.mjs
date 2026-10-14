import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChildren, reconcileCards } from '../web/catalog-renderer.js';

class Element {
  constructor(id = '') { this.id=id; this.children=[]; this.parent=null; this.dataset={}; this.mutations=0; }
  get isConnected() { return this.parent !== null; }
  insertBefore(child, before) {
    if(child.parent)child.remove();
    const index=before?this.children.indexOf(before):this.children.length;
    this.children.splice(index,0,child);child.parent=this;this.mutations++;
  }
  remove() { if(!this.parent)return;const parent=this.parent;parent.children.splice(parent.children.indexOf(this),1);parent.mutations++;this.parent=null; }
}

function renderer() {
  const grid=new Element('grid');let created=0;
  const options={key:item=>item.id,signature:item=>item.poster,create:item=>{created++;return new Element(item.id);}};
  return {grid,render:items=>reconcileCards(grid,items,options),created:()=>created};
}

test('updating favorite metadata keeps mounted posters, focus targets and DOM order',()=>{
  const render=renderer(),items=[{id:'movie:1',poster:'a'},{id:'movie:2',poster:'b'}];
  render.render(items);const cards=[...render.grid.children],mutations=render.grid.mutations;
  render.render(items.map(item=>({...item,favorite:true})));
  assert.deepEqual(render.grid.children,cards);assert.equal(render.grid.mutations,mutations);assert.equal(render.created(),2);
});

test('adding another page appends cards without detaching previously visible titles',()=>{
  const render=renderer(),first={id:'movie:1',poster:'a'};
  render.render([first]);const original=render.grid.children[0],mutations=render.grid.mutations;
  render.render([first,{id:'movie:2',poster:'b'}]);
  assert.equal(render.grid.children[0],original);assert.equal(render.grid.mutations,mutations+1);assert.equal(render.created(),2);
});

test('revisiting a category reuses decoded posters, but new artwork replaces the card',()=>{
  const render=renderer(),first={id:'movie:1',poster:'a'},second={id:'movie:2',poster:'b'};
  render.render([first]);const original=render.grid.children[0];render.render([second]);render.render([first]);
  assert.equal(render.grid.children[0],original);assert.equal(render.created(),2);
  render.render([{...first,poster:'updated'}]);assert.notEqual(render.grid.children[0],original);assert.equal(render.created(),3);
});

test('category changes retain shared titles and move only items whose position changes',()=>{
  const parent=new Element(),first=new Element('1'),second=new Element('2'),third=new Element('3');
  reconcileChildren(parent,[first,second,third]);reconcileChildren(parent,[third,second]);
  assert.deepEqual(parent.children,[third,second]);assert.equal(first.parent,null);assert.equal(second.parent,parent);assert.equal(third.parent,parent);
});
