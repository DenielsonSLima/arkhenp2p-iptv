import {catalogGenres} from './catalog-genres.js';
import {sortCatalogItems} from './catalog-sort.js';
import {latestReleases} from './home-sections.js';
import {isAdultItem} from './parental-classification.js';
import {ADULT_CATEGORY,RELEASES_CATEGORY} from './catalog-navigation.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const safeText=value=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'').slice(0,1000):'';

/** The daily projection travels atomically with its catalog, never separately
 * from another publication or parental scope. Explicit allowlist for IndexedDB. */
export function sanitizeCatalogReadModel(model,catalog,{type,includeAdult=false}={}){
  if(model?.schemaVersion!==1||model.mediaType!==type||model.includeAdult!==includeAdult||!uuid(model.snapshotId)||!uuid(model.generation)||model.snapshotId!==catalog?.pagination?.snapshotId||!Number.isFinite(Date.parse(model.revisionAt))||Date.parse(model.revisionAt)!==Date.parse(catalog?.pagination?.revisionAt)||!Number.isFinite(Date.parse(model.expiresAt))||model.total!==catalog.items?.length)return null;
  const known=new Set(catalog.items.map(item=>String(item.id)));if(known.size!==model.total)return null;
  const ids=(values,complete=false)=>{if(!Array.isArray(values)||values.length>known.size)return null;const seen=new Set();for(const value of values){if(!safeId(value)||!known.has(value)||seen.has(value))return null;seen.add(value);}return complete&&seen.size!==known.size?null:[...values];};
  const orders={};for(const mode of ['name','date','rating','releases','featured']){const value=ids(model.orders?.[mode],['name','date','rating'].includes(mode));if(!value)return null;orders[mode]=value;}
  if(orders.featured.length>36||!Array.isArray(model.categories)||model.categories.length>20000||!Array.isArray(model.genres)||model.genres.length>100)return null;
  const project=rows=>{const result=[],seen=new Set();for(const row of rows){const itemIds=ids(row.itemIds),name=safeText(row.name);if(!safeId(row.id)||!name||!itemIds||row.count!==itemIds.length||seen.has(row.id))return null;seen.add(row.id);result.push({id:row.id,name,itemIds,count:itemIds.length});}return result;};
  const categories=project(model.categories),genres=project(model.genres);if(!categories||!genres)return null;
  return {schemaVersion:1,mediaType:type,snapshotId:model.snapshotId,generation:model.generation,revisionAt:new Date(model.revisionAt).toISOString(),expiresAt:new Date(model.expiresAt).toISOString(),includeAdult,total:model.total,orders,categories,genres};
}

/** Rendering uses preordered IDs and membership lookups. Private visibility
 * changes are projected once; repeated progress/focus renders reuse the result.
 * Older offline snapshots keep a once-per-snapshot compatibility index. */
export class CatalogBrowseIndex{
  constructor(catalog){
    this.catalog=catalog;this.visibilityKey=null;this.selections=new Map();this.groups=new Map();this.genres=new Map();this.source=catalog.readModel?'supabase':'offline';
    const model=catalog.readModel;
    this.adultIds=new Set(catalog.items.filter(item=>isAdultItem(item,catalog.sourceCategories||catalog.categories)).map(item=>item.id));
    if(model){
      this.orders=model.orders;const sourceGroups=new Map(model.categories.map(group=>[group.id,group]));
      for(const group of catalog.categories){const ids=new Set();for(const id of group.ids)for(const itemId of sourceGroups.get(String(id))?.itemIds||[])ids.add(itemId);this.groups.set(group.id,ids);}
      for(const genre of model.genres)this.genres.set(genre.id,{...genre,ids:new Set(genre.itemIds)});
    }else{
      this.orders=Object.fromEntries(['name','date','rating'].map(mode=>[mode,sortCatalogItems(catalog.items,mode).map(item=>item.id)]));
      this.orders.releases=latestReleases(catalog.items,catalog.items.length).map(item=>item.id);
      for(const group of catalog.categories)this.groups.set(group.id,new Set());
      for(const item of catalog.items)for(const group of item.groupKeys||[item.groupKey])this.groups.get(group)?.add(item.id);
      if(catalog.items[0]?.kind!=='live'){const genres=catalogGenres(catalog);for(const genre of genres.choices){if(genre.id==='__all')continue;this.genres.set(genre.id,{id:genre.id,name:genre.name,ids:new Set()});}for(const item of catalog.items)for(const id of genres.genreIdsFor(item))this.genres.get(id)?.ids.add(item.id);}
    }
    this.groups.set(ADULT_CATEGORY,this.adultIds);this.groups.set(RELEASES_CATEGORY,new Set(this.orders.releases||[]));
  }
  project(visibilityKey,visible){
    if(this.visibilityKey===visibilityKey)return this;this.visibilityKey=visibilityKey;this.selections.clear();this.visible=new Set();
    for(const id of this.orders.name){const item=this.catalog.itemMap.get(id);if(item&&visible(item))this.visible.add(id);}
    this.genreIndex={choices:[{id:'__all',name:'Todos',count:[...this.visible].filter(id=>!this.adultIds.has(id)).length},...[...this.genres.values()].map(genre=>({id:genre.id,name:genre.name,count:[...genre.ids].filter(id=>this.visible.has(id)&&!this.adultIds.has(id)).length})).filter(genre=>genre.count)],matches:(item,genre)=>genre==='__all'||this.genres.get(genre)?.ids.has(String(item.id))===true};
    this.categoryProjections=new Map();return this;
  }
  idsFor(category,genre){return {category:category==='__all'?null:this.groups.get(category)||new Set(),genre:genre==='__all'?null:this.genres.get(genre)?.ids||new Set()};}
  select({category='__all',genre='__all',sort='date'}={}){
    const key=JSON.stringify([category,genre,sort]);if(this.selections.has(key))return this.selections.get(key);
    const membership=this.idsFor(category,genre),items=[];for(const id of this.orders[sort]||this.orders.date)if(this.visible.has(id)&&(category===ADULT_CATEGORY||!this.adultIds.has(id))&&(!membership.category||membership.category.has(id))&&(!membership.genre||membership.genre.has(id)))items.push(this.catalog.itemMap.get(id));
    if(this.selections.size>=16)this.selections.delete(this.selections.keys().next().value);this.selections.set(key,items);return items;
  }
  categories(genre='__all'){
    if(this.categoryProjections.has(genre))return this.categoryProjections.get(genre);const membership=this.idsFor('__all',genre).genre;
    const groups=this.catalog.categories.map(group=>{let count=0;for(const id of this.groups.get(group.id)||[])if(this.visible.has(id)&&!this.adultIds.has(id)&&(!membership||membership.has(id)))count++;return {...group,count};}).filter(group=>group.count);
    this.categoryProjections.set(genre,groups);return groups;
  }
}
