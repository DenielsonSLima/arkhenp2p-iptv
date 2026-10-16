const copy = value => typeof value === 'string' ? value : '';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const roles = track => (track.audioRoles || track.roles || []).join('|');

export function audioIdentity(track) {
  return track.audioId !== null && track.audioId !== undefined ? `id:${track.audioId}`
    : JSON.stringify([track.audioLanguage || track.language, roles(track), track.audioCodec, track.channelsCount, track.label]);
}

function audioFamily(track) {
  return JSON.stringify([track.audioLanguage || track.language, roles(track), track.audioCodec, track.channelsCount]);
}

/** Every entry retains its original public Shaka track for explicit selection.
 * No synthetic resolution, bitrate, URL or fragment is introduced. */
export function readShakaTracks(player) {
  const variants = player.getVariantTracks?.() || [];
  const active = variants.find(track => track.active);
  const offered = active ? variants.filter(track => audioFamily(track) === audioFamily(active)) : variants;
  const levelTracks = offered.length ? offered : variants;
  const levels = levelTracks.map(track => ({
    id: track.id, width: positive(track.width), height: positive(track.height),
    bitrate: positive(track.bandwidth), frameRate: positive(track.frameRate),
    videoCodec: copy(track.videoCodec), audioCodec: copy(track.audioCodec), name: copy(track.videoLabel || track.label),
    _shakaTrack: track
  }));
  const audioTracks = [], seen = new Set();
  for (const track of variants) {
    if (track.audioId == null && !track.audioCodec && !track.audioMimeType) continue;
    const id = audioIdentity(track);
    if (seen.has(id)) continue;
    seen.add(id);
    audioTracks.push({id, name: copy(track.label || track.audioLanguage || track.language),
      lang: copy(track.audioLanguage || track.language), _shakaTrack: track});
  }
  const subtitleTracks = (player.getTextTracks?.() || []).map(track => ({id: track.id,
    name: copy(track.label || track.language), lang: copy(track.language), _shakaTrack: track}));
  return {variants, active, levels, audioTracks, subtitleTracks};
}

export function sameAudioCandidates(variants, track) {
  return variants.filter(candidate => audioIdentity(candidate) === audioIdentity(track));
}
