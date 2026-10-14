const positive = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

function durationString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const clock = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(text);
  if (clock) return positive(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text);
  if (iso) return positive(Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0));
  const units = /^(?:(\d+(?:\.\d+)?)\s*(?:h|horas?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|minutos?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|seg|segundos?)\s*)?$/i.exec(text);
  return units ? positive(Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)) : null;
}

function displayDuration(seconds) {
  const total = Math.floor(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  if (hours) return `${hours} h${minutes ? ` ${minutes} min` : ''}`;
  if (minutes) return `${minutes} min`;
  return `${total} s`;
}

// A number called "duration" or "runtime" has no unit in the OTT contract.
// Preserve only explicit units/time codes; absent or ambiguous values stay blank.
export function mediaDuration(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    let seconds;
    for (const key of ['durationSeconds', 'duration_seconds', 'runtimeSeconds', 'runtime_seconds']) {
      seconds = positive(source[key]);
      if (seconds !== null) break;
    }
    if (seconds == null) {
      for (const key of ['durationMinutes', 'duration_minutes', 'runtimeMinutes', 'runtime_minutes']) {
        const minutes = positive(source[key]);
        if (minutes !== null) { seconds = minutes * 60; break; }
      }
    }
    if (seconds == null) {
      for (const key of ['duration', 'runtime', 'runTime', 'run_time']) {
        seconds = durationString(source[key]);
        if (seconds !== null) break;
      }
    }
    if (seconds != null && Number.isSafeInteger(Math.floor(seconds)) && seconds >= 1) return { duration: displayDuration(seconds), durationSeconds: seconds };
  }
  return { duration: '', durationSeconds: null };
}
