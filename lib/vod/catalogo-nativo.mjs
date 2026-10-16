import { createHash } from 'node:crypto';
import { adultCategory, decodeText, ProviderError, safeID } from '../provider.mjs';
import { validUpstreamURL } from '../upstream.mjs';

// Shared native VOD metadata/catalogue kernel. Movies and series retain separate
// maps and generations; HTTP/auth/playback still belong to the injected client.

const list=value=>Array.isArray(value)?value:[];
const text=value=>decodeText(value&&typeof value==='object'?value.init??value.i18n?.en??'':value);
const keyText=value=>text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const numericID=value=>/^\d{1,12}$/.test(String(value??''))?String(value):null;
const kindHint=value=>/\b(?:series?|seriados?|novelas?|doramas?|reality)\b/.test(keyText(value))?'series':/\b(?:filmes?|movies?|cinema)\b/.test(keyText(value))?'movies':null;
const opaqueID=value=>String(BigInt('0x'+createHash('sha256').update(value).digest('hex').slice(0,16))%1_000_000_000_000n);

// Public identifiers never include source URLs, provider tokens, or opaque IDs.
// A title namespace also prevents two shows with equal episode IDs colliding.
export function nativeEpisodeID(titleID,source,index=0) {
  if(numericID(source._id??source.id))return numericID(source._id??source.id);
  const opaque=String(source._id??source.id??`${source.subTitle??''}:${index}`);
  return opaqueID(`${titleID}:${opaque}`);
}

export class WplayVODCatalog {
  constructor(client,tokenURL) {
    this.client=client;this.tokenURL=tokenURL;this.categories=new Map();this.pages=new Map();
    this.items={movies:new Map(),series:new Map()};this.initializing=new Map();this.registered=false;
    this.generations={movies:0,series:0};this.registrationGeneration=0;
  }
  invalidate(type) {
    // Refresh one media type without discarding the other type's loaded pages.
    // Generations also prevent in-flight requests from repopulating old data.
    this.generations[type]++;this.items[type].clear();this.initializing.delete(type);
    this.registrationGeneration++;this.registered=false;
    for(const key of this.pages.keys())if(key.startsWith(type+':'))this.pages.delete(key);
    const pagePrefix=`wplay:vod-page:${type}:`,detailPrefix=`wplay:vod-detail:${type==='movies'?'movie':'series'}:`;
    for(const key of this.client.cache.keys())if(key.startsWith(pagePrefix)||key.startsWith(detailPrefix)||key.startsWith('wplay:vod-tags:'))this.client.cache.delete(key);
  }
  async register() {
    if(this.registered)return;
    const generation=this.registrationGeneration;
    try{await this.client.memo(`wplay:vod-tags:${generation}`,async()=>{
      const groups=await this.client.requestJSON(this.client.serviceURL('vod_tag_url'));
      if(generation!==this.registrationGeneration)return;
      if(!Array.isArray(groups))throw new ProviderError('O serviço WPlay retornou categorias de vídeo inválidas.','WPLAY_INVALID_CATALOG');
      const categories=new Map();
      for(const group of groups){
        for(const tag of list(group?.items)){
          const name=text(tag?.name),hint=kindHint(name)||kindHint(group?.group_name);
          if(!name||typeof tag.url!=='string')continue;
          const original=tag._id??tag.id;
          if(original==null)continue;
          const id=numericID(original)||opaqueID(`category:${group.group_id??text(group.group_name)}:${String(original)}`);
          let url;try{url=validUpstreamURL(tag.url,this.client.allowPrivate).href;}catch{continue;}
          // The category's returned URL is the only allowed pagination source.
          const restricted=group.restrictedAccess===true||tag.restrictedAccess===true||adultCategory(name)||adultCategory(text(group.group_name))||/\+18/.test(name+' '+text(group.group_name));
          if(!categories.has(id))categories.set(id,{id,name,url,hint,restricted});
          else if(restricted)categories.get(id).restricted=true;
        }
      }
      if(!categories.size)throw new ProviderError('O serviço WPlay não retornou categorias de vídeo disponíveis.','WPLAY_EMPTY_CATALOG',503);
      this.categories=categories;this.registered=true;
    });}catch(error){if(generation===this.registrationGeneration)throw error;}
    if(generation!==this.registrationGeneration)return this.register();
  }
  relevant(type) {return [...this.categories.values()].filter(category=>!category.hint||category.hint===type);}
  snapshot(type) {
    const categories=this.relevant(type),byCategory={};
    for(const category of categories){const page=this.pages.get(`${type}:${category.id}`);byCategory[category.id]={nextPage:page?.nextPage??1,hasMore:page?.hasMore??true,loaded:!!page?.loaded};}
    return {categories:categories.map(({id,name,restricted})=>({id,name,...(restricted?{isAdult:true}:{})})),items:[...this.items[type].values()],pagination:{mode:'category',byCategory}};
  }
  async catalog(type) {
    const generation=this.generations[type];await this.register();
    if(generation!==this.generations[type])return this.catalog(type);
    if(!this.initializing.has(type)){
      const categories=this.relevant(type).filter(category=>!category.restricted).sort((a,b)=>Number(/lan[cç]amento|recent/i.test(b.name))-Number(/lan[cç]amento|recent/i.test(a.name))).slice(0,4);
      const promise=Promise.allSettled(categories.map(category=>this.page(type,category.id,1))).then(results=>{
        if(results.length&&results.every(result=>result.status==='rejected'))throw results[0].reason;
      }).catch(error=>{if(this.initializing.get(type)===promise)this.initializing.delete(type);throw error;});
      this.initializing.set(type,promise);
    }
    try{await this.initializing.get(type);}catch(error){if(generation===this.generations[type])throw error;}
    if(generation!==this.generations[type])return this.catalog(type);
    return this.snapshot(type);
  }
  async page(type,categoryID,pageNumber) {
    const generation=this.generations[type];await this.register();
    if(generation!==this.generations[type])return this.catalog(type);
    const category=this.categories.get(String(categoryID)),page=Number(pageNumber);
    if(!category||category.hint&&category.hint!==type)throw new ProviderError('Categoria indisponível para este catálogo.','WPLAY_CATEGORY_INVALID',400);
    if(!Number.isSafeInteger(page)||page<1||page>10000)throw new ProviderError('Página de catálogo inválida.','WPLAY_PAGE_INVALID',400);
    const pageKey=`${type}:${category.id}`,previous=this.pages.get(pageKey);
    if(previous&&!previous.hasMore&&page>=previous.nextPage)return this.snapshot(type);
    if(page>(previous?.nextPage??1))throw new ProviderError('Carregue a página anterior deste catálogo.','WPLAY_PAGE_INVALID',400);
    try{await this.client.memo(`wplay:vod-page:${type}:${generation}:${category.id}:${page}`,async()=>{
      const base=this.tokenURL(category.url,this.client.authInfo?.service?.token);
      const payload=await this.client.requestJSON(base+(base.includes('?')?'&':'?')+'page='+page);
      if(generation!==this.generations[type])return;
      if(!Array.isArray(payload))throw new ProviderError('O serviço WPlay retornou uma página de vídeos inválida.','WPLAY_INVALID_CATALOG');
      for(const raw of payload){
        if(!raw||typeof raw!=='object')continue;
        const kind=this.client.isSeries(raw)?'series':category.hint==='series'?'series':'movie';
        const catalogType=kind==='series'?'series':'movies';
        if(catalogType!==type)continue;
        const result=this.client.normalizeItems([raw],kind,[{id:category.id,name:category.name,...(category.restricted?{isAdult:true}:{})}]);
        const item=result.items[0];if(!item)continue;
        const old=this.items[catalogType].get(item.id);
        const categoryIds=[...new Set([...(old?.categoryIds||[]),...(item.categoryIds||[]),category.id])];
        this.items[catalogType].set(item.id,{...old,...item,categoryId:old?.categoryId||category.id,categoryIds});
      }
      const current=this.pages.get(pageKey);
      this.pages.set(pageKey,{nextPage:Math.max(current?.nextPage??1,page+1),hasMore:payload.length>0,loaded:true});
    });}catch(error){if(generation===this.generations[type])throw error;}
    if(generation!==this.generations[type])return this.catalog(type);
    return this.snapshot(type);
  }
  async detail(type,id) {
    const catalogType=type==='movie'?'movies':'series',generation=this.generations[catalogType];
    id=safeID(id);await this.register();
    if(generation!==this.generations[catalogType])return this.detail(type,id);
    let detail;
    try{detail=await this.client.memo(`wplay:vod-detail:${type}:${generation}:${id}`,async()=>{
      const base=this.client.authInfo?.service?.vod_search_url;
      if(typeof base!=='string'||!base)throw new ProviderError('O serviço WPlay não disponibilizou os detalhes deste título.','WPLAY_DETAILS_UNAVAILABLE',404);
      // APK: raw SEARCH URL + /@chid, then the authentication token.
      const url=validUpstreamURL(this.tokenURL(base+'/@'+id,this.client.authInfo?.service?.token),this.client.allowPrivate).href;
      const payload=await this.client.requestJSON(url);
      if(generation!==this.generations[catalogType])return;
      // The native search endpoint returns {} for an unknown title (including
      // identifiers from another provider). This is absence, not bad gateway.
      if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&Object.keys(payload).length===0)
        throw new ProviderError('Este título não está disponível no catálogo atual. Volte ao início e escolha outro conteúdo.','WPLAY_TITLE_NOT_FOUND',404);
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||numericID(payload.chid??payload.id)!==id)throw new ProviderError('O serviço WPlay retornou detalhes inválidos.','WPLAY_INVALID_DETAILS');
      const old=this.client.rawItems.get(`${type}:${id}`)||{};
      this.client.rawItems.set(`${type}:${id}`,{...old,...payload});
      const normalized=this.client.normalizeItems([{...old,...payload}],type).items[0];
      if(!normalized)throw new ProviderError('Título indisponível neste catálogo.','WPLAY_INVALID_DETAILS');
      const map=this.items[catalogType],previous=map.get(id);
      const item={...previous,...normalized,categoryId:previous?.categoryId||normalized.categoryId,categoryIds:previous?.categoryIds||[normalized.categoryId]};
      map.set(id,item);return {item,raw:{...old,...payload}};
    });}catch(error){if(generation===this.generations[catalogType])throw error;}
    if(generation!==this.generations[catalogType])return this.detail(type,id);
    // A later category page may contain a short source list. Keep playback on
    // the complete detail response even when the detail request is cached.
    this.client.rawItems.set(`${type}:${id}`,detail.raw);
    return detail.item;
  }
}
