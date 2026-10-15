const aliases = new Map([['sportv 1','sportv'],['redetv','rede tv']]);
const suffix = /(?:^|\s)(sd|hd|fhd|full\s?hd|uhd|4k|480p?|576p?|720p?|1080p?|1440p?|2160p?|hevc|avc|h\s?26[45]|x\s?26[45])$/i;
const positiveNumber=value=>{
  if(typeof value!=='number' && !(typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value.trim())))return null;
  const number=Number(value);return Number.isFinite(number)&&number>0?number:null;
};

function normalized(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu,' ').replace(/\s+/g,' ').trim();
}
function sourceName(value) {
  let name=normalized(value), match;const qualities=new Set(), codecs=new Set();
  while ((match=suffix.exec(name))) {
    const tag=match[1].replace(/\s/g,'');
    if (/^(?:hevc|h265|x265)$/.test(tag)) codecs.add('hevc');
    else if (/^(?:avc|h264|x264)$/.test(tag)) codecs.add('avc');
    else qualities.add(/^(?:4k|uhd|2160p?)$/.test(tag) ? 2160 : /^(?:fhd|fullhd|1080p?)$/.test(tag) ? 1080 : /^1440p?$/.test(tag) ? 1440 : /^(?:hd|720p?)$/.test(tag) ? 720 : 480);
    name=name.slice(0,match.index).trim();
  }
  name=name.replace(/\s*\+\s*/g,'+');
  return {family:aliases.get(name) || name, rank:qualities.size===1 ? [...qualities][0] : null, codec:codecs.size===1 ? [...codecs][0] : null};
}

// Remove only terminal delivery labels. Regions, cameras and time shifts remain
// channel identity; quality is a provider claim, never measured resolution.
export function channelFamily(name) {return sourceName(name).family;}
export function channelQualityRank(value) {return sourceName(typeof value==='string' ? value : value?.name).rank;}
export function channelCodec(item) {
  const codec=String(item?.source?.videoCodec || item?.videoCodec || '').toLowerCase();
  if (/^(?:hev[1c]|hvc1|h[. -]?265|hevc)/.test(codec)) return 'hevc';
  if (/^(?:avc[13]?|h[. -]?264)/.test(codec)) return 'avc';
  return sourceName(item?.name).codec;
}
export function declaredSourceBitrate(item) {
  return positiveNumber(item?.bitrateBps ?? item?.source?.bitrateBps);
}
export function findChannelVariants(item, items=[]) {
  if (item?.kind!=='live') return [];
  const family=channelFamily(item.name);if (!family) return [];
  const seen=new Set();
  return (Array.isArray(items) ? items : []).filter(candidate=>{
    const id=String(candidate?.id ?? '');
    if (candidate?.kind!=='live' || !id || channelFamily(candidate.name)!==family || seen.has(id)) return false;
    seen.add(id);return true;
  });
}

// MediaCapabilities requires a complete codec profile and real dimensions,
// bitrate and frame rate. A label such as "4K HEVC" cannot provide those.
export function sourceDecodingConfiguration(item, type='media-source') {
  const source=item?.source || {},codec=String(source.videoCodec || item?.videoCodec || '');
  const width=positiveNumber(source.width ?? item?.width),height=positiveNumber(source.height ?? item?.height);
  const bitrate=declaredSourceBitrate(item),framerate=positiveNumber(source.frameRate ?? item?.frameRate);
  if (!/^(?:avc[13]|hvc1|hev1|av01|vp09)\.[a-z0-9.]+$/i.test(codec) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !bitrate || !framerate) return null;
  return {type,video:{contentType:`video/mp4; codecs="${codec}"`,width,height,bitrate,framerate}};
}

export function measuredQualityLabel(height, width) {
  // Runtime callers supply both decoded dimensions. Height-only labels are
  // reserved for declared manifest levels, identified as announced in the UI.
  const is4K=width===undefined ? height===2160 : Number.isSafeInteger(width)&&width>=3840&&height>=2160;
  return Number.isSafeInteger(height) && height>0 ? `${height}p${is4K ? ' · 4K' : ''}` : '';
}
