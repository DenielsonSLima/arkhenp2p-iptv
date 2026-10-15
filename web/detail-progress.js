import { formatMediaTime } from './immersive-player.js';

const positiveSeconds = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && Number.isSafeInteger(Math.floor(seconds)) && seconds > 0 ? seconds : null;
};

/** Match saved playback to the exact title and, for a series, its real episode. */
export function detailPlaybackProgress(item, entry) {
  if (!['movie','series'].includes(item?.kind) || !String(item?.id ?? '').trim() || !entry?.item ||
      entry.item.kind !== item.kind || String(entry.item.id) !== String(item.id)) return null;
  const savedTime = positiveSeconds(entry.time);
  if (savedTime === null) return null;
  let episode = null;
  if (item.kind === 'series') {
    if (!entry.episode?.id) return null;
    episode = (Array.isArray(item.seasons) ? item.seasons : [])
      .flatMap(season => Array.isArray(season?.episodes) ? season.episodes : [])
      .find(value => value && String(value.id) === String(entry.episode.id));
    if (!episode) return null;
  }
  // A saved video duration was measured by the player. A movie's explicit
  // durationSeconds is also usable; a series runtime is not an episode runtime.
  const duration = positiveSeconds(entry.duration) ?? (item.kind === 'movie' ? positiveSeconds(item.durationSeconds) : null);
  const time = duration === null ? savedTime : Math.min(savedTime, duration);
  const season = Number(episode?.season ?? entry.episode?.season), number = Number(episode?.number ?? entry.episode?.number);
  const episodeLabel = episode && Number.isInteger(season) && season >= 0 && Number.isInteger(number) && number > 0 ? `T${season} · E${number}` : '';
  const elapsed = formatMediaTime(time), total = duration === null ? '' : formatMediaTime(duration);
  return {time, duration, percent:duration === null ? null : time / duration * 100, elapsed, total, episodeLabel};
}

function node(tag, className, text) {
  const element = document.createElement(tag);element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Insert between playback actions and the synopsis; also supports async metadata. */
export function renderDetailProgress(summary, item, entry) {
  const data = detailPlaybackProgress(item, entry);
  summary.querySelector?.(':scope > .detail-resume')?.remove();
  if (!data) return null;
  const root = node('div', 'detail-resume');
  if (data.episodeLabel) root.append(node('span', 'detail-resume-episode', `Seu episódio · ${data.episodeLabel}`));
  const caption = node('div', 'detail-resume-caption'), position = node('span', 'detail-resume-position', 'Você parou em ');
  position.append(node('strong', '', data.elapsed));
  const total = node('span', 'detail-resume-total', data.total ? 'Duração total ' : 'Duração não informada');
  if (data.total) total.append(node('strong', '', data.total));
  caption.append(position, total);root.append(caption);
  if (data.duration !== null) {
    const progress = node('progress', 'detail-resume-progress');progress.max = data.duration;progress.value = data.time;
    progress.setAttribute('aria-label', item.kind === 'series' ? `Progresso do episódio${data.episodeLabel ? ' '+data.episodeLabel : ''}` : 'Progresso do filme');
    progress.setAttribute('aria-valuetext', `${data.elapsed} assistidos de ${data.total} no total`);
    root.append(progress);
  }
  const synopsis = summary.querySelector?.(':scope > .detail-plot');
  if (synopsis) summary.insertBefore(root, synopsis);else summary.append(root);
  return root;
}
