import {ProviderError,decodeText} from '../../provider.mjs';
import {liveSourceRank} from './fontes.mjs';

const title = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';
const unavailable = () => new ProviderError('O player web WPLAY está indisponível no momento. Tente novamente.', 'WPLAY_WEB_UNAVAILABLE', 503);

// Delivery labels are separate from channel identity. Keep accents, regions,
// numbers, time shifts and punctuation; only recognized terminal labels leave
// the name used for the cross-catalog association.
const deliverySuffix = /(?:^|\s)(?:\[|\()?(full\s*hd|sd|hd|fhd|uhd|4k|(?:480|576|720|1080|1440|2160)p|hevc|avc|h[.\s-]?26[45]|x[.\s-]?26[45])(?:\]|\))?$/u;
function liveLabel(value) {
  let name = title(decodeText(value)); const qualities = new Set(), codecs = []; let match;
  while ((match = deliverySuffix.exec(name))) {
    const tag = match[1].replace(/[.\s-]/gu, '');
    if (/^(?:hevc|avc|[hx]26[45])$/u.test(tag)) codecs.unshift(tag);
    else qualities.add(
      /^(?:uhd|4k|2160p)$/u.test(tag) ? 'uhd' : /^(?:fhd|fullhd|1080p)$/u.test(tag) ? 'fhd'
        : /^1440p$/u.test(tag) ? '1440p' : /^(?:hd|720p)$/u.test(tag) ? 'hd' : 'sd');
    name = name.slice(0, match.index).trim();
  }
  return { name, codec: codecs.join(' '), quality: qualities.size === 1 ? [...qualities][0] : '', conflict: qualities.size > 1 };
}
const nativeIdentity = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^\d{1,12}$/u.test(value) ? value : null;
const explicitNativeIDs = raw => ['chid', 'nativeChannelId', 'sourceChannelId'].map(key => nativeIdentity(raw?.[key])).filter(Boolean);
const publicLabel = value => {
  const label=decodeText(value).normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim();
  return /[a-z][a-z\d+.-]*:\/\/|(?:^|[?&])(?:token|password|authorization|cookie)=/iu.test(label)?'[nome indisponível]':label.slice(0,160);
};
const diagnosticWords = name => new Set(name.split(/[^\p{L}\p{N}]+/u).filter(word=>word.length>1&&!['tv','canal'].includes(word)));

/** Public catalog metadata only. Similar words select diagnostic examples,
 * never playback candidates or aliases. No raw IDs, sources or URLs escape. */
function mappingFailure(item,client,catalog,matches,code,status,message){
  const wanted=liveLabel(item?.name),words=diagnosticWords(wanted.name),seen=new Set(),candidates=[],matchedIDs=new Set(matches.map(match=>match.sourceId));
  let candidateCount=0;
  for(const candidate of catalog?.items||[]){
    if(candidate?.kind!=='live')continue;
    const raw=client.rawItems?.get(`live:${candidate.id}`);if(!raw||!['string','number'].includes(typeof raw.id))continue;
    const label=liveLabel(raw.title||candidate.name),key=String(raw.id);
    if(seen.has(key))continue;seen.add(key);
    const overlap=[...diagnosticWords(label.name)].filter(word=>words.has(word)).length;
    const explicit=matchedIDs.has(key),exact=label.name===wanted.name;
    if(!explicit&&!exact&&!overlap)continue;
    candidateCount++;
    const qualities=[...new Set((Array.isArray(raw.liveVariants)?raw.liveVariants:[]).map(variant=>liveLabel(variant?.quality).quality).filter(Boolean))];
    if(!qualities.length&&label.quality)qualities.push(label.quality);
    candidates.push({name:publicLabel(raw.title||candidate.name),qualities:qualities.slice(0,8),score:explicit?1000:exact?100:overlap});
    candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));if(candidates.length>8)candidates.pop();
  }
  const diagnostic={code,nativeChannel:{id:nativeIdentity(item?.id),name:publicLabel(item?.name)},
    matchedCount:matchedIDs.size,candidateCount,
    candidates:candidates.map(({name,qualities})=>({name,qualities}))};
  const error=new ProviderError(message,code,status);
  Object.defineProperty(error,'mappingDiagnostic',{value:diagnostic});return error;
}

/** Match complete provider labels, never an opaque ID fragment or partial title. */
export function resolveWplayWebLiveItems(item, client, catalog, { nativeItem } = {}) {
  const wanted = liveLabel(item?.name), matches = [], identities = new Set(
    [nativeIdentity(item?.id), ...explicitNativeIDs(nativeItem)].filter(Boolean));
  let sharedIdentityFound = false;
  if (item?.kind !== 'live' || !wanted.name) throw unavailable();
  for (const candidate of catalog?.items || []) {
    if (candidate?.kind !== 'live') continue;
    const raw = client.rawItems?.get(`live:${candidate.id}`);
    if (!raw || !['string', 'number'].includes(typeof raw.id)) continue;
    const label = liveLabel(raw.title || candidate.name);
    const sharedID = explicitNativeIDs(raw).some(id => identities.has(id));
    if (sharedID) sharedIdentityFound = true;
    if (!sharedID && label.name !== wanted.name) continue;
    let quality = '',metadata = {};
    // This is the existing OTT adapter's identity contract, not an association
    // between its opaque raw ID and a native WPLAY channel ID.
    for (const variant of Array.isArray(raw.liveVariants) ? raw.liveVariants : []) {
      const key = `item:live:${String(raw.id)}:quality:${String(variant?.quality ?? '')}`;
      if (client.identity(key) === String(candidate.id)) { quality = decodeText(variant?.quality); metadata = variant; break; }
    }
    const delivery = liveLabel(quality || candidate.name), selectedQuality = delivery.quality || label.quality;
    if (wanted.conflict || delivery.conflict || label.conflict) continue;
    if (delivery.quality && label.quality && delivery.quality !== label.quality) continue;
    matches.push({ item: candidate, sourceId: String(raw.id), quality: quality || selectedQuality, qualityKey:selectedQuality,
      sharedID, exactCodecLabel:label.codec===wanted.codec, raw, metadata });
  }
  // An explicitly shared native field takes precedence over a label. The OTT
  // adapter's hashed candidate.id and opaque raw.id are never native aliases.
  if (sharedIdentityFound) matches.splice(0, matches.length, ...matches.filter(match => match.sharedID));
  if (!matches.length) throw mappingFailure(item,client,catalog,matches,'WPLAY_WEB_CHANNEL_NOT_FOUND',404,'Não encontramos este canal com o mesmo nome no player web WPLAY.');
  let group = matches;
  // A provider may publish "Channel" and "Channel H265" as distinct raw IDs.
  // Prefer its complete title (apart from quality) before relaxing codec labels;
  // otherwise stripping H265 makes an exact, unique title falsely ambiguous.
  // Use raw.title, not candidate.name: the adapter appends each variant's label
  // to candidate.name. Never join variants from separate provider identities.
  if (!sharedIdentityFound) {
    const exact = group.filter(match => match.exactCodecLabel);
    if (exact.length) group = exact;
  }
  if (new Set(group.map(match => match.sourceId)).size > 1 && wanted.quality) {
    const qualified = group.filter(match => match.qualityKey === wanted.quality);
    if (new Set(qualified.map(match => match.sourceId)).size === 1) group = group.filter(match => match.sourceId === qualified[0].sourceId);
  }
  if (new Set(group.map(match => match.sourceId)).size !== 1) throw mappingFailure(item,client,catalog,group,'WPLAY_WEB_CHANNEL_AMBIGUOUS',409,'O player web WPLAY retornou canais com nomes iguais. Não foi possível identificar este canal com segurança.');
  return group;
}
export function resolveWplayWebLiveItem(item,client,catalog,options={}){
  return initialWplayWebMatch(item,resolveWplayWebLiveItems(item,client,catalog,options),options)?.item;
}

/** ARKHEN starts at the highest declared resolution of the safely associated
 * channel. The channel label already disambiguated identity above; it does not
 * override explicit sourceId selection or force an initial HD variant. */
export function initialWplayWebMatch(_item,matches){
  const rank=match=>liveSourceRank({declaredHeight:match.metadata?.height,quality:match.quality||match.qualityKey});
  return [...matches].sort((a,b)=>rank(b)-rank(a))[0]||null;
}
