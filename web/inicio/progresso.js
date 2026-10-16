export function playbackProgress(entry) {
  const time = Number(entry?.time), duration = Number(entry?.duration);
  const hasTime = Number.isFinite(time) && time > 0;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const percent = hasTime && hasDuration ? Math.max(0, Math.min(100, time / duration * 100)) : null;
  const completed = percent !== null && percent >= 95;
  const episode = entry?.item?.kind === 'series' ? entry.episode : null;
  const season = Number(episode?.season), number = Number(episode?.number);
  const episodeLabel = Number.isInteger(season) && season > 0 && Number.isInteger(number) && number > 0 ? `T${season} · E${number}` : '';
  return {percent, completed, resumable:hasTime && time > 5 && !completed, episodeLabel};
}
