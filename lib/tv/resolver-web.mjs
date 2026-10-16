import {ProviderError,decodeText} from '../provider.mjs';
import {liveSourceRank} from './fontes.mjs';

const title = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';
const unavailable = () => new ProviderError('O player web WPLAY está indisponível no momento. Tente novamente.', 'WPLAY_WEB_UNAVAILABLE', 503);

// Delivery labels are separate from channel identity. Keep accents, regions,
// numbers, time shifts and punctuation; only recognized terminal labels leave
// the name used for the cross-catalog association.
const deliverySuffix = /(?:^|\s)(?:\[|\()?(full\s*hd|sd|hd|fhd|uhd|4k|(?:480|576|720|1080|1440|2160)p|hevc|avc|h[.\s-]?26[45]|x[.\s-]?26[45])(?:\]|\))?$/u;
function liveLabel(value) {
  let name = title(decodeText(value)); const qualities = new Set(); let match;
  while ((match = deliverySuffix.exec(name))) {
    const tag = match[1].replace(/[.\s-]/gu, '');
    if (!/^(?:hevc|avc|[hx]26[45])$/u.test(tag)) qualities.add(
      /^(?:uhd|4k|2160p)$/u.test(tag) ? 'uhd' : /^(?:fhd|fullhd|1080p)$/u.test(tag) ? 'fhd'
        : /^1440p$/u.test(tag) ? '1440p' : /^(?:hd|720p)$/u.test(tag) ? 'hd' : 'sd');
    name = name.slice(0, match.index).trim();
  }
  return { name, quality: qualities.size === 1 ? [...qualities][0] : '', conflict: qualities.size > 1 };
}
const nativeIdentity = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^\d{1,12}$/u.test(value) ? value : null;
const explicitNativeIDs = raw => ['chid', 'nativeChannelId', 'sourceChannelId'].map(key => nativeIdentity(raw?.[key])).filter(Boolean);

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
    matches.push({ item: candidate, sourceId: String(raw.id), quality: quality || selectedQuality, qualityKey:selectedQuality, sharedID, raw, metadata });
  }
  // An explicitly shared native field takes precedence over a label. The OTT
  // adapter's hashed candidate.id and opaque raw.id are never native aliases.
  if (sharedIdentityFound) matches.splice(0, matches.length, ...matches.filter(match => match.sharedID));
  if (!matches.length) throw new ProviderError('Não encontramos este canal com o mesmo nome no player web WPLAY.', 'WPLAY_WEB_CHANNEL_NOT_FOUND', 404);
  let group = matches;
  if (new Set(group.map(match => match.sourceId)).size > 1 && wanted.quality) {
    const qualified = group.filter(match => match.qualityKey === wanted.quality);
    if (new Set(qualified.map(match => match.sourceId)).size === 1) group = group.filter(match => match.sourceId === qualified[0].sourceId);
  }
  if (new Set(group.map(match => match.sourceId)).size !== 1) throw new ProviderError('O player web WPLAY retornou canais com nomes iguais. Não foi possível identificar este canal com segurança.', 'WPLAY_WEB_CHANNEL_AMBIGUOUS', 409);
  return group;
}
export function resolveWplayWebLiveItem(item,client,catalog,options={}){
  return resolveWplayWebLiveItems(item,client,catalog,options).sort((a,b)=>liveSourceRank({quality:b.quality.toUpperCase()})-liveSourceRank({quality:a.quality.toUpperCase()}))[0].item;
}
