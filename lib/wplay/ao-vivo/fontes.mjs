import {createHash} from 'node:crypto';
import {ProviderError,decodeText} from '../../provider.mjs';
import {validUpstreamURL} from '../../upstream.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>decodeText(typeof value==='string'||typeof value==='number'?value:'').replace(/https?:\/\/\S+/gi,'').slice(0,200);
const positive=(value,maximum=Number.MAX_SAFE_INTEGER)=>{
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim())))return null;
  const number=Number(value);return Number.isFinite(number)&&number>0&&number<=maximum?number:null;
};
const heights={SD:480,HD:720,FHD:1080,'1440P':1440,UHD:2160,'4K':2160,'8K':4320};
export function liveQuality(value){
  const label=text(value).toUpperCase().replace(/FULL\s*HD/g,'FHD');
  const found=label.match(/(?:^|[^A-Z0-9+])(SD|HD|FHD|UHD|4K|8K|480P|576P|720P|1080P|1440P|2160P|4320P)(?=$|[^A-Z0-9+])/g)||[];
  const qualities=[...new Set(found.map(part=>part.match(/(?:SD|HD|FHD|UHD|4K|8K|\d+P)/)?.[0]).filter(Boolean))];
  return qualities.length===1?qualities[0]:null;
}
export function liveSourceRank(source){
  const height=positive(source?.declaredHeight,16384);if(height)return height;
  const quality=liveQuality(source?.quality)||liveQuality(source?.label);
  return heights[quality]||(/^(?:480|576|720|1080|1440|2160|4320)P$/.test(quality||'')?Number(quality.slice(0,-1)):0);
}

/** Internal entries retain addresses; only liveSourceCatalog projects them. */
export function liveSourceEntry(channelId,{address,origin='native',label,quality,metadata={},available=true,key,reason,...privateFields}){
  label=text(label)||'Fonte original';quality=liveQuality(quality||label);
  // Web URLs can rotate between catalogue discovery and playback on another
  // instance. The provider item identifies its variant without binding its ID
  // to a temporary transport URL. Other transports retain their exact IDs.
  const identity=origin==='web'&&key!==undefined&&key!==null&&String(key)!==''&&typeof privateFields.itemId==='string'&&privateFields.itemId!==''
    ?[String(channelId),origin,'provider-item-v2',String(key),String(privateFields.itemId),label,quality]
    :[String(channelId),origin,key??'',String(address??''),label];
  const descriptor={id:(origin==='web'?'w_':origin==='ott'?'o_':'n_')+digest(identity).slice(0,28),label,available:available===true};
  if(quality)descriptor.quality=quality;
  // A name such as 4K supplies only quality, never invented pixel dimensions.
  const width=positive(metadata.width,16384),height=positive(metadata.height,16384),frameRate=positive(metadata.frameRate??metadata.fps,240);
  if(Number.isInteger(width))descriptor.declaredWidth=width;
  if(Number.isInteger(height))descriptor.declaredHeight=height;
  if(frameRate)descriptor.frameRate=frameRate;
  const bitrate=positive(metadata.bitrateBps)??(positive(metadata.kbps)?positive(metadata.kbps)*1000:null);
  if(bitrate)descriptor.bitrateBps=bitrate;
  const codec=text(metadata.videoCodec??metadata.codec);if(codec)descriptor.videoCodec=codec;
  if(!descriptor.available&&reason)descriptor.reason=reason;
  return {...privateFields,address,origin,descriptor};
}
export function nativeLiveSourceEntries(channelId,raw,{allowPrivate=false}={}){
  const entries=[];
  for(const [index,source] of (Array.isArray(raw?.sources)?raw.sources:[]).entries()){
    if(!source||typeof source!=='object')continue;
    for(const field of ['address','address_backup']){
      const address=source[field];if(typeof address!=='string'||!address)continue;
      if(field==='address_backup'&&!/^https?:\/\//i.test(address))continue;
      let available=false,protocol='unsupported';
      if(/^https?:\/\//i.test(address)){try{validUpstreamURL(address,allowPrivate);available=true;protocol='http';}catch{}}
      else if(/^tvbus:\/\/[^\s\x00-\x1f\x7f]{1,8192}$/.test(address))protocol='tvbus';
      const label=text(source.subTitle??source.quality??source.label)||`Fonte ${index+1}`;
      entries.push(liveSourceEntry(channelId,{address,origin:'native',label:field==='address_backup'?`${label} · alternativa`:label,
        quality:source.quality??source.subTitle,metadata:source,available,key:field,source,index,field,protocol,
        reason:protocol==='tvbus'?'web-source-required':'transport-unavailable'}));
    }
  }
  return uniqueLiveSources(entries);
}
export function ottLiveSourceEntries(channelId,raw,resolveURL){
  const variants=Array.isArray(raw?.liveVariants)&&raw.liveVariants.length?raw.liveVariants:[{playbackUrl:raw?.playbackUrl,quality:raw?.quality}];
  return uniqueLiveSources(variants.map((variant,index)=>{
    const supplied=variant?.playbackUrl||raw?.playbackUrl;let address='';try{address=resolveURL(supplied).href;}catch{}
    return liveSourceEntry(channelId,{address,origin:'ott',label:text(variant?.quality)||`Fonte ${index+1}`,
      quality:variant?.quality,metadata:variant||{},available:!!address,key:String(raw?.id??''),variant,index});
  }));
}
export function uniqueLiveSources(entries){
  const seen=new Set();return entries.filter(entry=>{const id=entry?.descriptor?.id;if(!id||seen.has(id))return false;seen.add(id);return true;});
}
export function selectLiveSource(entries,sourceId){
  if(sourceId!==undefined&&sourceId!==null&&sourceId!==''){
    if(typeof sourceId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(sourceId))throw new ProviderError('A fonte selecionada é inválida.','LIVE_SOURCE_INVALID',400);
    const chosen=entries.find(entry=>entry.descriptor.id===sourceId);
    if(!chosen)throw new ProviderError('As fontes deste canal foram atualizadas. Abra a lista de qualidades novamente.','LIVE_SOURCE_CHANGED',409);
    if(!chosen.descriptor.available)throw new ProviderError('Esta fonte não está disponível no player desta sessão.','LIVE_SOURCE_UNAVAILABLE',503);
    return chosen;
  }
  return entries.filter(entry=>entry.descriptor.available).sort((a,b)=>liveSourceRank(b.descriptor)-liveSourceRank(a.descriptor))[0]||null;
}
export function liveSourceCatalog(channelId,entries,selectedSourceId){
  const sources=uniqueLiveSources(entries).map(entry=>({...entry.descriptor}));
  const selected=sources.some(source=>source.available&&source.id===selectedSourceId)?selectedSourceId:selectLiveSource(entries)?.descriptor.id||null;
  return {channelId:String(channelId),revision:digest(sources),selectedSourceId:selected,sources};
}
