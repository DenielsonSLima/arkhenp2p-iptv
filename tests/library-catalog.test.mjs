import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLibraryItem} from '../web/library-catalog.js';
import {isAdultItem} from '../web/parental-classification.js';
import {cloudItem} from '../web/cloud-library-records.js';
const A='a'.repeat(64),B='b'.repeat(64),context={libraryId:A,activeLibraryId:A},item={id:'999',kind:'live',name:'Saved channel',categoryId:'9',poster:'/api/image?ref=old',libraryId:A};
test('private saved titles survive missing paginated catalog rows without accepting another account or old image handles',()=>{
  const partial={catalogComplete:false,itemMap:new Map()},saved=resolveLibraryItem(item,{...context,catalog:partial});assert.equal(saved.id,'999');assert.equal(saved.poster,'');assert.equal(saved.libraryId,A);
  assert.equal(resolveLibraryItem(item,{...context,activeLibraryId:B,catalog:partial}),null);assert.equal(resolveLibraryItem({...item,libraryId:B},{...context,catalog:partial}),null);
  const unavailable=resolveLibraryItem(item,{...context,catalog:{...partial,catalogComplete:true}});assert.equal(unavailable.catalogUnavailable,true);assert.equal(unavailable.id,'999');
  const current={...item,name:'Current name',poster:'/assets/channels/logo-1234567890abcdef.webp'};assert.equal(resolveLibraryItem(item,{...context,catalog:{itemMap:new Map([['999',current]])}}).name,'Current name');
});
test('saved title classification and category memberships survive cloud normalization and partial fallback',()=>{
  const protectedItem=cloudItem({...item,categoryIds:['9','18'],isAdult:true,groupNames:['VIP +18']});assert.equal(protectedItem.isAdult,true);assert.deepEqual(protectedItem.categoryIds,['9','18']);
  const saved=resolveLibraryItem(protectedItem,context);assert.equal(isAdultItem(saved),true);assert.deepEqual(saved.groupNames,['VIP +18']);
});
