import {canonicalSeries,imdbID} from '../../../supabase/functions/series-markers-sync/metadata.mjs';
import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';
const normalized=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function reviewCatalogTitle(item){
  const name=String(item?.name||'').trim().replace(/(?:\s*\((?:leg|dub|dual|hd|fhd|4k)\)|\s+(?:leg|dub|dual|hd|fhd|4k))+$/i,'').trim();
  const match=/\s*-\s*((?:19|20)\d{2})$/.exec(name),rawYear=/^(?:19|20)\d{2}$/.test(String(item?.year||''))?Number(item.year):null;
  return {name:match?name.slice(0,match.index).trim():name,year:rawYear||(match?Number(match[1]):null),yearConflict:Boolean(rawYear&&match&&rawYear!==Number(match[1]))};
}
export function prioritizedReviewSeries(items,library=[],limit=50){
  const selected=[],seen=new Set(),titles=new Set(),add=item=>{const title=reviewCatalogTitle(item),key=normalized(title.name)+':'+title.year;if(item?.kind!=='series'||!/^\d{1,12}$/.test(String(item.id))||!String(item.name||'').trim()||seen.has(String(item.id))||titles.has(key))return false;seen.add(String(item.id));titles.add(key);selected.push({...item,id:String(item.id)});return true;};
  for(const item of library){if(selected.length>=limit)break;add({...item,priorityReason:'Já presente entre os itens do aplicativo'});}
  const categories=new Map();for(const item of items){const category=item.sourceCategory?.name||'Catálogo';if(!categories.has(category))categories.set(category,[]);categories.get(category).push(item);}
  for(const rows of categories.values())rows.sort((a,b)=>(Number(b.rating)||0)-(Number(a.rating)||0)||(a.providerOrder||0)-(b.providerOrder||0));
  for(;;){let added=false;for(const rows of categories.values()){
    while(rows.length){const item=rows.shift();if(add({...item,priorityReason:'Nota do provedor e diversidade de categorias do catálogo capturado'})){added=true;break;}}
    if(selected.length>=limit)return selected.slice(0,limit);
  }if(!added)break;}
  return selected;
}
export function reviewedSeriesIdentity(item,{imdbPayload,skipdbPayload,wikidataEntities={}}={}){
  const expected=reviewCatalogTitle(item);if(expected.yearConflict)return {status:'unresolved',reason:'CATALOG_YEAR_CONFLICT'};
  if(!expected.year)return {status:'unresolved',reason:'CATALOG_YEAR_REQUIRED'};
  const candidates=new Map(),imdbRows=(imdbPayload?.d||[]).filter(row=>imdbID(row.id)&&['tvSeries','tvMiniSeries'].includes(row.qid)&&row.y===expected.year);
  const add=(id,name,method,sources,tmdb=null)=>{if(!imdbID(id))return;const existing=candidates.get(id);candidates.set(id,{...canonicalSeries(id,name,tmdb??existing?.tmdb_id),year:expected.year,method,sources:[...new Set([...(existing?.sources||[]),...sources])]});};
  const imdbURL='https://v3.sg.media-imdb.com/suggestion/x/'+encodeURIComponent(expected.name)+'.json';
  for(const row of imdbRows)if(normalized(row.l)===normalized(expected.name))add(row.id,row.l,'imdb-exact-title-year',[imdbURL,'https://www.imdb.com/title/'+row.id+'/']);
  const known=SERIES_MARKER_REGISTRY.find(series=>series.aliases.some(alias=>normalized(alias)===normalized(expected.name)));
  if(known){const row=imdbRows.find(row=>row.id===known.imdbId);if(row)add(row.id,row.l,'curated-exact-alias-and-imdb-type-year',[imdbURL,'https://www.imdb.com/title/'+row.id+'/'],known.tmdbId);}
  for(const row of skipdbPayload?.local||[]){const id=row.imdb_id??row.imdbId;if(row.media_type==='series'&&Number(row.year)===expected.year&&normalized(row.name)===normalized(expected.name))add(id,row.name,'skipdb-exact-title-year',['https://skipdb.tv/api/titles/search?q='+encodeURIComponent(expected.name)],row.tmdb_id??row.tmdbId);}
  for(const entity of Object.values(wikidataEntities)){
    const names=[...Object.values(entity?.labels||{}).map(row=>row.value),...Object.values(entity?.aliases||{}).flat().map(row=>row.value)];if(!names.some(name=>normalized(name)===normalized(expected.name)))continue;
    for(const claim of entity.claims?.P345||[]){const id=claim.mainsnak?.datavalue?.value,row=imdbRows.find(row=>row.id===id);if(row)add(id,row.l,'wikidata-exact-alias-and-imdb-type-year',[imdbURL,'https://www.wikidata.org/wiki/'+entity.id,'https://www.imdb.com/title/'+id+'/']);}
  }
  return candidates.size===1?{status:'resolved',identity:[...candidates.values()][0]}:{status:candidates.size?'ambiguous':'unresolved',reason:candidates.size?'IDENTITY_AMBIGUOUS':'EXACT_IDENTITY_NOT_VERIFIED'};
}
