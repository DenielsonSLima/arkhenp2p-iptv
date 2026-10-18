/** Explicit per-episode duration and presentation only. The active video owns
 * measured runtime; a series-level total is never inferred from episode one. */
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER && value > 0 ? value : null;

export function episodeDurationSeconds(episode) {
  const value = episode?.durationSeconds;
  const numeric = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (seconds(numeric) !== null) return numeric;
  // A bare provider number such as "45" has no unit. Only explicit clocks or
  // units may be interpreted here, never a series-level runtime.
  const text = typeof episode?.duration === 'string' ? episode.duration.trim() : '';
  const clock = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(text);
  if (clock) return seconds(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  const units = /^(?:(\d+(?:\.\d+)?)\s*(?:h|horas?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|minutos?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|seg|segundos?)\s*)?$/i.exec(text);
  return units ? seconds(Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)) : null;
}
export function formatEpisodeTime(value) {
  const total = Math.floor(value), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), tail = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}

