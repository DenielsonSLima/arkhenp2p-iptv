// Public API references retain their provenance, even when used for autoplay.
export const referenceTypes=['intro','recap','outro','preview','post_credits'];
export function markerRequest(value){
  const {imdbId,season,episode,duration}=value||{};
  if(!/^tt\d{6,10}$/.test(imdbId||'')||!Number.isSafeInteger(season)||season<0||season>1000||
    !Number.isSafeInteger(episode)||episode<1||episode>10000||!Number.isFinite(duration)||duration<=0||duration>86400)return null;
  return {imdbId,season,episode,duration:Math.round(duration*1000)/1000};
}
export const markerRequestKey=value=>JSON.stringify([value.imdbId,value.season,value.episode,value.duration]);
export function sourceSegments(source,payload,request){
  if(!payload||payload.imdb_id!==request.imdbId||payload.season!==request.season||payload.episode!==request.episode)return null;
  const raw=source==='SkipDB'?payload.segments:payload;
  if(!raw||!referenceTypes.some(type=>Object.hasOwn(raw,type)||type==='post_credits'&&Object.hasOwn(raw,'post-credits')))return null;
  const segments={};
  for(const type of referenceTypes){
    const part=raw[type]??(type==='post_credits'?raw['post-credits']:null);if(!part)continue;
    if(source==='SkipDB'&&part.start_ms===0&&part.end_ms===0){segments[type]=null;continue;}
    const start=part.start_ms/1000,end=part.end_ms/1000;
    if(typeof part.start_ms!=='number'||typeof part.end_ms!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||
      start<0||end<=start||start>=request.duration||end>request.duration+2||end-start>(['intro','recap'].includes(type)?300:900))continue;
    segments[type]={start,end:Math.min(end,request.duration),source,
      ...(typeof part.match==='string'&&['exact','shifted','agnostic','out-of-range'].includes(part.match)?{match:part.match}:{})};
  }
  return segments;
}
export function validEpisodeReference(value,context){
  const request=markerRequest(context);
  if(!request||value?.schemaVersion!==1||!['reference','empty','unavailable'].includes(value.status)||
    markerRequestKey(value)!==markerRequestKey(request)||!value.segments||typeof value.segments!=='object'||Array.isArray(value.segments))return false;
  if((value.status==='reference')!==(Object.keys(value.segments).length>0))return false;
  return Object.entries(value.segments).every(([type,part])=>referenceTypes.includes(type)&&part&&['SkipDB','IntroDB'].includes(part.source)&&
    Number.isFinite(part.start)&&Number.isFinite(part.end)&&part.start>=0&&part.end>part.start&&part.end<=request.duration&&
    part.end-part.start<=(['intro','recap'].includes(type)?300:900));
}
export function referenceActions(reference,time,duration){
  const segments=reference?.segments||{},intro=segments.intro,outro=segments.outro;
  const opening=Boolean(intro&&time>=intro.start&&time<intro.end);
  const later=outro?['post_credits','preview','recap','intro'].map(type=>segments[type]).filter(part=>part&&part.start>=outro.start):[];
  const creditsEnd=outro?Math.min(outro.end,...later.map(part=>part.start)):undefined;
  const credits=Boolean(outro&&time>=outro.start&&time<creditsEnd);
  // API outro.end can land at a post-credit scene. Never discard that end.
  const final=Boolean(outro&&duration-outro.end<=.5&&!later.length);
  return {opening,credits,openingStart:intro?.start,openingEnd:intro?.end,creditsStart:outro?.start,creditsEnd,final};
}
