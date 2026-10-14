import { withoutSessionArtwork } from './stored-artwork.js';

const key = item => `${item.kind}:${item.id}`;
const list = value => Array.isArray(value) ? value : [];
const valid = item => item && ['live','movie','series'].includes(item.kind) && typeof item.id === 'string' && typeof item.name === 'string';
const title = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Provider IDs are different namespaces. Keep legacy records intact, and adopt
// them only after both their ID and title match this connection's real catalog.
export class MediaLibrary {
  constructor({read,save,favorites,history}) {
    Object.assign(this,{read,save,favorites,history});
    this.legacyFavorites=list(read('orbit.favorites.v1',[])).filter(valid);
    this.legacyHistory=list(read('orbit.history.v1',[])).filter(entry=>valid(entry?.item)&&Number.isFinite(entry.time));
  }
  activate(provider) {
    this.provider=['wplay','wplay-ott','xtream'].includes(provider)?provider:'xtream';
    this.prefix=`orbit.library.v2.${this.provider}`;
    this.adopted=new Set(list(this.read(`${this.prefix}.adopted`,[])).filter(value=>typeof value==='string'));
    this.favorites.clear();this.history.clear();
    for(const item of list(this.read(`${this.prefix}.favorites`,[])).filter(valid))this.favorites.set(key(item),withoutSessionArtwork(item));
    for(const entry of list(this.read(`${this.prefix}.history`,[])).filter(entry=>valid(entry?.item)&&Number.isFinite(entry.time)))this.history.set(key(entry.item),{...entry,item:withoutSessionArtwork(entry.item)});
  }
  saveFavorites() {if(this.prefix)this.save(`${this.prefix}.favorites`,[...this.favorites.values()].map(withoutSessionArtwork));}
  saveHistory() {if(this.prefix)this.save(`${this.prefix}.history`,[...this.history.values()].map(entry=>({...entry,item:withoutSessionArtwork(entry.item)})));}
  migrate(catalog) {
    if(!this.prefix)return;
    const current=new Map((catalog?.items||[]).map(item=>[key(item),item]));
    let changed=false,favoritesChanged=false,historyChanged=false;
    const adopt=(stored,section)=>{
      const id=key(stored),migration=`${section}:${id}`,item=current.get(id);
      if(this.adopted.has(migration)||!item||title(item.name)!==title(stored.name))return null;
      this.adopted.add(migration);changed=true;
      return {id,item:withoutSessionArtwork({...stored,...item,savedAt:stored.savedAt})};
    };
    for(const stored of this.legacyFavorites){const adopted=adopt(stored,'favorites');if(adopted&&!this.favorites.has(adopted.id)){this.favorites.set(adopted.id,adopted.item);favoritesChanged=true;}}
    for(const entry of this.legacyHistory){const adopted=adopt(entry.item,'history');if(adopted&&!this.history.has(adopted.id)){this.history.set(adopted.id,{...entry,item:adopted.item});historyChanged=true;}}
    if(favoritesChanged)this.saveFavorites();if(historyChanged)this.saveHistory();
    if(changed)this.save(`${this.prefix}.adopted`,[...this.adopted]);
  }
}
