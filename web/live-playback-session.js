let sequence=0;
export function createLiveAttempt(){return globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}_${(++sequence).toString(36)}`;}

// Chromium's optional native HLS declaration does not imply Safari's pipeline.
export function supportsNativeHLS(video,navigator=globalThis.navigator){
  const agent=navigator?.userAgent||'';
  const safari=/Safari\//.test(agent)&&!/Chrome\/|Chromium\/|Edg\/|OPR\//.test(agent);
  const ios=/iP(?:hone|ad|od)/.test(agent)||navigator?.platform==='MacIntel'&&navigator?.maxTouchPoints>1;
  return Boolean((safari||ios)&&video.canPlayType('application/vnd.apple.mpegurl'));
}
