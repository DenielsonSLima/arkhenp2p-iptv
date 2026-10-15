import { withoutSessionArtwork } from './stored-artwork.js';

const key = item => `${item.kind}:${item.id}`;
const list = value => Array.isArray(value) ? value : [];
const valid = item => item && ['live','movie','series'].includes(item.kind) && typeof item.id === 'string' && typeof item.name === 'string';
const title = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const validHistory = entry => valid(entry?.item)&&Number.isFinite(entry.time);
const accountID = value => typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():'';
const authorizedImport = 'legacy:authorized';

// Provider IDs are different namespaces. Keep legacy records intact, and adopt
// them only after both their ID and title match this connection's real catalog.
export class MediaLibrary {
  constructor({read,save,favorites,history}) {
    Object.assign(this,{read,save,favorites,history});
    this.legacyFavorites=list(read('orbit.favorites.v1',[])).filter(valid);
    this.legacyHistory=list(read('orbit.history.v1',[])).filter(entry=>valid(entry?.item)&&Number.isFinite(entry.time));
  }
  activate(provider,accountId) {
    this.provider=['wplay','wplay-ott','xtream'].includes(provider)?provider:'xtream';
    this.accountId=accountID(accountId);
    this.providerPrefix=`orbit.library.v2.${this.provider}`;
    this.prefix=this.accountId?`orbit.library.v3.${this.provider}.${this.accountId}`:this.providerPrefix;
    this.currentItems=new Map();
    this.adopted=new Set(list(this.read(`${this.prefix}.adopted`,[])).filter(value=>typeof value==='string'));
    this.favorites.clear();this.history.clear();
    for(const item of list(this.read(`${this.prefix}.favorites`,[])).filter(valid))this.favorites.set(key(item),withoutSessionArtwork(item));
    for(const entry of list(this.read(`${this.prefix}.history`,[])).filter(validHistory)){
      if(this.accountId&&entry.libraryId&&entry.libraryId!==this.accountId)continue;
      this.history.set(key(entry.item),{...entry,...(this.accountId?{libraryId:this.accountId}:{}),item:withoutSessionArtwork(entry.item)});
    }
    // Only an exact account tag proves ownership of records from shared v2/v1.
    // Untagged data stays untouched until the user deliberately imports it.
    if(this.accountId)this.#adoptVerifiedHistory();
  }
  saveFavorites() {if(this.prefix)this.save(`${this.prefix}.favorites`,[...this.favorites.values()].map(withoutSessionArtwork));}
  saveHistory() {if(this.prefix)this.save(`${this.prefix}.history`,[...this.history.values()].map(entry=>({...entry,...(this.accountId?{libraryId:this.accountId}:{}),item:withoutSessionArtwork(entry.item)})));}
  #legacyRecords(){
    const favoriteSources=[...list(this.read(`${this.providerPrefix}.favorites`,[])),...this.legacyFavorites];
    const historySources=[...list(this.read(`${this.providerPrefix}.history`,[])),...this.legacyHistory];
    const favorites=new Map(),history=new Map();
    for(const item of favoriteSources.filter(valid))if(!item.libraryId||item.libraryId===this.accountId)if(!favorites.has(key(item)))favorites.set(key(item),item);
    for(const entry of historySources.filter(validHistory)){
      if(entry.libraryId&&entry.libraryId!==this.accountId)continue;
      const id=key(entry.item),previous=history.get(id);
      if(!previous||Number(entry.updated||0)>Number(previous.updated||0))history.set(id,entry);
    }
    return {favorites:[...favorites.values()],history:[...history.values()]};
  }
  #adoptVerifiedHistory(){
    let changed=false,historyChanged=false;
    const verified=new Map();
    for(const entry of [...list(this.read(`${this.providerPrefix}.history`,[])),...this.legacyHistory].filter(validHistory)){
      if(entry.libraryId!==this.accountId)continue;
      const id=key(entry.item),previous=verified.get(id);
      if(!previous||Number(entry.updated||0)>Number(previous.updated||0))verified.set(id,entry);
    }
    for(const entry of verified.values()){
      const id=key(entry.item),marker=`history:${id}`;
      if(this.adopted.has(marker))continue;
      this.adopted.add(marker);changed=true;
      if(!this.history.has(id)){this.history.set(id,{...entry,item:withoutSessionArtwork(entry.item)});historyChanged=true;}
    }
    if(historyChanged)this.saveHistory();
    if(changed)this.save(`${this.prefix}.adopted`,[...this.adopted]);
  }
  legacySummary(){
    if(!this.accountId)return {available:false,favorites:0,history:0,authorized:false};
    const records=this.#legacyRecords(),favorites=records.favorites.filter(item=>!this.adopted.has(`favorites:${key(item)}`)).length;
    const history=records.history.filter(entry=>!this.adopted.has(`history:${key(entry.item)}`)).length,authorized=this.adopted.has(authorizedImport);
    return {available:!authorized&&favorites+history>0,favorites,history,authorized};
  }
  /** User consent applies only to this account; source records remain unchanged. */
  importLegacy(){
    if(!this.accountId)return {favorites:0,history:0,pending:0};
    const before={favorites:this.favorites.size,history:this.history.size};
    this.adopted.add(authorizedImport);this.save(`${this.prefix}.adopted`,[...this.adopted]);
    this.migrate({items:[...this.currentItems.values()]});
    const remaining=this.legacySummary();
    return {favorites:this.favorites.size-before.favorites,history:this.history.size-before.history,pending:remaining.favorites+remaining.history};
  }
  migrate(catalog) {
    if(!this.prefix)return;
    const current=new Map((catalog?.items||[]).map(item=>[key(item),item]));
    for(const [id,item] of current)this.currentItems.set(id,item);
    if(this.accountId&&!this.adopted.has(authorizedImport))return;
    const sources=this.accountId?this.#legacyRecords():{favorites:this.legacyFavorites,history:this.legacyHistory};
    let changed=false,favoritesChanged=false,historyChanged=false;
    const adopt=(stored,section)=>{
      const id=key(stored),migration=`${section}:${id}`,item=current.get(id);
      if(this.adopted.has(migration)||!item||title(item.name)!==title(stored.name))return null;
      this.adopted.add(migration);changed=true;
      return {id,item:withoutSessionArtwork({...stored,...item,savedAt:stored.savedAt})};
    };
    for(const stored of sources.favorites){const adopted=adopt(stored,'favorites');if(adopted&&!this.favorites.has(adopted.id)){this.favorites.set(adopted.id,adopted.item);favoritesChanged=true;}}
    for(const entry of sources.history){const adopted=adopt(entry.item,'history');if(adopted&&!this.history.has(adopted.id)){this.history.set(adopted.id,{...entry,...(this.accountId?{libraryId:this.accountId}:{}),item:adopted.item});historyChanged=true;}}
    if(favoritesChanged)this.saveFavorites();if(historyChanged)this.saveHistory();
    if(changed)this.save(`${this.prefix}.adopted`,[...this.adopted]);
  }
}
