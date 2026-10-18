import {timingSafeEqual} from 'node:crypto';
import {isAdultCategory,isAdultItem} from '../web/parental-classification.js';

const catalogType=kind=>kind==='movie'?'movies':kind;
const key=(kind,id)=>`${kind}:${String(id)}`;
const denied=()=>Object.assign(new Error('Conteúdo protegido. Desbloqueie o controle parental para continuar.'),{status:403,code:'PARENTAL_LOCKED'});
/** Ephemeral browser-session authorization. No PIN or unlock state enters cloud data. */
export class ParentalControl{
  constructor({now=Date.now,maxAttempts=5,cooldownMs=60000,lookupItem}={}){Object.assign(this,{now,maxAttempts,cooldownMs,lookupItem});this.reset();}
  reset(){this.unlocked=false;this.failed=0;this.blockedUntil=0;this.items=new Map();this.categories=new Map();this.episodes=new Map();this.artworks=new Map();}
  status(){return {unlocked:this.unlocked,locked:!this.unlocked,retryAfterSeconds:Math.max(0,Math.ceil((this.blockedUntil-this.now())/1000))};}
  unlock(pin){
    const wait=this.status().retryAfterSeconds;
    if(wait)throw Object.assign(new Error(`Aguarde ${wait} segundos antes de tentar novamente.`),{status:429,code:'PARENTAL_RATE_LIMITED',retryAfterSeconds:wait});
    if(this.blockedUntil){this.failed=0;this.blockedUntil=0;}
    const supplied=typeof pin==='string'&&/^\d{4}$/.test(pin)?Buffer.from(pin):Buffer.from('----');
    if(!timingSafeEqual(supplied,Buffer.from('0000'))){
      if(++this.failed>=this.maxAttempts){this.blockedUntil=this.now()+this.cooldownMs;throw Object.assign(new Error('Muitas tentativas. Aguarde um minuto antes de tentar novamente.'),{status:429,code:'PARENTAL_RATE_LIMITED',retryAfterSeconds:Math.ceil(this.cooldownMs/1000)});}
      throw Object.assign(new Error('PIN incorreto. Tente novamente.'),{status:403,code:'PARENTAL_PIN_INVALID'});
    }
    this.unlocked=true;this.failed=0;this.blockedUntil=0;return this.status();
  }
  lock(){this.unlocked=false;return this.status();}
  #rememberArtwork(item,kind,id){for(const field of ['poster','backdrop','posterOriginal','thumbnail'])if(typeof item?.[field]==='string'&&item[field].startsWith('/api/')){if(!this.artworks.has(item[field]))this.artworks.set(item[field],new Set());this.artworks.get(item[field]).add(key(kind,id));}}
  rememberCatalog(data,type){
    if(!Array.isArray(data?.categories)||!Array.isArray(data?.items))return;
    const categories=new Map(this.categories.get(type)||[]);for(const category of data.categories)categories.set(String(category.id),category);this.categories.set(type,categories);
    for(const item of data.items){const kind=item.kind||(type==='movies'?'movie':type);this.items.set(key(kind,item.id),{...item,kind,classified:true,isAdult:isAdultItem(item,[...categories.values()])});this.#rememberArtwork(item,kind,item.id);}
  }
  filterCatalog(data,type){
    this.rememberCatalog(data,type);if(this.unlocked||!data)return data;
    const categories=(data.categories||[]).filter(category=>!isAdultCategory(category));
    const items=(data.items||[]).filter(item=>!this.items.get(key(item.kind||(type==='movies'?'movie':type),item.id))?.isAdult);
    const allowed=new Set(categories.map(category=>String(category.id))),byCategory=data.pagination?.byCategory;
    return {...data,categories,items,...(byCategory?{pagination:{...data.pagination,byCategory:Object.fromEntries(Object.entries(byCategory).filter(([id])=>allowed.has(id)||id==='__all'&&data.pagination.source==='supabase'))}}:{})};
  }
  registerDetails(kind,id,details){
    const known=this.items.get(key(kind,id)),categories=[...(this.categories.get(catalogType(kind))?.values()||[])];
    const adult=Boolean(known?.isAdult||isAdultItem(details,categories)),ids=(details?.categoryIds||[details?.categoryId]).filter(value=>value!==undefined&&value!==null).map(String);
    const classified=Boolean(known?.classified||adult||categories.some(category=>ids.includes(String(category.id))));
    const item={...known,...details,id:String(id),kind,classified,isAdult:adult};this.items.set(key(kind,id),item);
    this.#rememberArtwork(item,kind,id);
    if(kind==='series')for(const season of details?.seasons||[])for(const episode of season.episodes||[]){this.episodes.set(String(episode.id),{kind,id:String(id)});this.#rememberArtwork(episode,kind,id);}
    return item;
  }
  assertItem(kind,id){
    if(this.unlocked)return;
    const item=this.items.get(key(kind,id));if(!item?.classified||item.isAdult)throw denied();
  }
  assertPlayback(kind,id){
    if(this.unlocked)return;
    if(kind==='series'){const parent=this.episodes.get(String(id));if(!parent)throw denied();this.assertItem(parent.kind,parent.id);}
    else this.assertItem(kind,id);
  }
  async authorizeArtwork(url,lookup){
    if(this.unlocked)return;
    let owners=this.artworks.get(url);
    if(!owners?.size&&lookup){const found=await lookup();if(found?.catalog){this.rememberCatalog(found.catalog,catalogType(found.kind));owners=this.artworks.get(url);}}
    if(!owners?.size)throw denied();
    for(const owner of owners){const item=this.items.get(owner);if(!item?.classified||item.isAdult)throw denied();}
  }
  async authorize(client,kind,id,{details,loadCatalog}={}){
    if(this.unlocked){if(details)this.registerDetails(kind,id,details);return;}
    if(!this.items.has(key(kind,id))&&!loadCatalog&&this.lookupItem){const metadata=await this.lookupItem(kind,String(id));if(metadata)this.rememberCatalog(metadata,catalogType(kind));}
    if(!this.items.has(key(kind,id))){const catalog=await (loadCatalog?loadCatalog():client.catalog(catalogType(kind)));this.rememberCatalog(catalog,catalogType(kind));}
    if(details)this.registerDetails(kind,id,details);
    if(!this.items.has(key(kind,id))&&kind==='movie'){const metadata=await client.details(kind,id);this.registerDetails(kind,id,metadata);}
    this.assertItem(kind,id);
  }
}
