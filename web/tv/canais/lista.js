import {CatalogBrowseIndex} from '../../catalog-read-model.js';
import {catalogIsComplete} from '../../catalog-repository.js';
import {resolveLibraryItem} from '../../library-catalog.js';
import {sortCatalogItems} from '../../catalog-sort.js';
import {tvScopeKey} from '../scope.js';

const scopeKey=tvScopeKey;
const channel=value=>value?.kind==='live'&&/^\d{1,12}$/.test(String(value.id??''));

/** Read-only TV view over the existing account catalogue repository. Loading
 * stays in the established live pipeline; this module does not download a
 * second catalogue or load movies/series to enumerate channels. */
export class TVChannelList{
  constructor({repository,loadCatalog,getCatalog,getScope=()=>null,isVisible=()=>true,isCategoryAllowed=()=>true,
    getNumber=()=>null,getFavorites=()=>[],onChange=()=>{}}={}){
    Object.assign(this,{repository,loadCatalog,getCatalog,getScope,isVisible,isCategoryAllowed,getNumber,getFavorites,onChange});
    this.scope=null;this.epoch=0;this.pending=null;this.revalidatePending=false;this.indexes=new WeakMap();this.listeners=new Set();
  }
  #synchronize(){const key=scopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;}
  #catalog(){
    if(!this.#synchronize())return null;
    return this.getCatalog?.('live')||this.repository?.state?.('live')?.current||null;
  }
  snapshot(){
    const catalog=this.#catalog();if(!catalog)return null;
    return {...catalog,items:(catalog.items||[]).filter(item=>channel(item)&&this.isVisible(item)),
      categories:(catalog.categories||[]).filter(category=>this.isCategoryAllowed('live',category.id)),loading:Boolean(this.pending)};
  }
  get(id){const catalog=this.#catalog(),item=catalog?.itemMap?.get(String(id))||(catalog?.items||[]).find(item=>String(item.id)===String(id));return channel(item)&&this.isVisible(item)?item:null;}
  readModel(){return this.#catalog()?.readModel||null;}
  #index(){
    const catalog=this.#catalog();if(!catalog?.itemMap||!catalogIsComplete(catalog))return null;
    let index=this.indexes.get(catalog);if(!index){index=new CatalogBrowseIndex(catalog);this.indexes.set(catalog,index);}
    return index.project(this.scope,item=>channel(item)&&this.isVisible(item));
  }
  select({category='__all',sort='name',favorites=false}={}){
    if(category==='__favorites')favorites=true;
    const catalog=this.#catalog(),scope=this.getScope(),account=scope?.account||scope?.libraryId;
    if(!this.scope||!account)return [];
    if(favorites){
      const values=this.getFavorites(),items=(values instanceof Map?[...values.values()]:Array.isArray(values)?values:[])
        .filter(channel).map(item=>resolveLibraryItem(item,{catalog,libraryId:account,activeLibraryId:account}))
        .filter(item=>item&&this.isVisible(item));
      return sortCatalogItems(items,sort);
    }
    const snapshot=this.snapshot();if(!snapshot)return [];
    const index=this.#index(),items=index?index.select({category,sort,genre:'__all'}):sortCatalogItems(snapshot.items.filter(item=>
      category==='__all'||(item.groupKeys||[item.groupKey]).includes(category)||(item.categoryIds||[item.categoryId]).map(String).includes(String(category))),sort);
    return items.filter(item=>channel(item)&&this.isVisible(item));
  }
  numbered(){return this.select().map((item,index)=>({item,number:this.getNumber(item.id,index+1,item)})).filter(entry=>Number.isSafeInteger(Number(entry.number))&&Number(entry.number)>0).map(entry=>({...entry,number:Number(entry.number)}));}
  categories(){const index=this.#index();return index?index.categories().filter(category=>this.isCategoryAllowed('live',category.id)):this.snapshot()?.categories||[];}
  #publish(){const snapshot=this.snapshot();try{this.onChange(snapshot);}catch{}for(const listener of [...this.listeners]){try{listener(snapshot);}catch{}}return snapshot;}
  subscribe(listener){this.listeners.add(listener);listener(this.snapshot());return()=>this.listeners.delete(listener);}
  load({force=false,revalidate=false}={}){
    const scope=this.#synchronize();if(!scope||typeof this.loadCatalog!=='function')return Promise.resolve(null);
    if(this.pending){if(revalidate)this.revalidatePending=true;return this.pending.promise;}
    const ticket={scope,epoch:this.epoch,promise:null};this.pending=ticket;
    ticket.promise=Promise.resolve().then(()=>{
      if(ticket.epoch!==this.epoch||ticket.scope!==scopeKey(this.getScope()))return null;
      return this.loadCatalog('live',force,{revalidate});
    }).then(()=>{
      if(ticket.epoch!==this.epoch||ticket.scope!==scopeKey(this.getScope()))return null;
      if(this.pending===ticket)this.pending=null;return this.#publish();
    }).finally(()=>{
      const current=ticket.epoch===this.epoch&&ticket.scope===scopeKey(this.getScope());
      if(this.pending===ticket){this.pending=null;this.#publish();}
      if(current&&this.revalidatePending){this.revalidatePending=false;void this.load({revalidate:true}).catch(()=>{});}
    });return ticket.promise;
  }
  invalidate({reload=false}={}){this.indexes=new WeakMap();return reload?this.load({revalidate:true}):this.#publish();}
  reset(){this.epoch++;this.scope=null;this.pending=null;this.revalidatePending=false;this.indexes=new WeakMap();}
  dispose(){this.reset();this.listeners.clear();}
}
