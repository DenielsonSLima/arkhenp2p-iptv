import { artworkURL } from './channel-artwork.js';
import { movieWithPlaybackDuration } from './movie-preview.js';
import { previewText, previewYear, previewRating } from './preview-tools.js';

// Panoramas must have enough real pixels for a banner. A portrait remains a
// framed cover; title lettering and thumbnail strips never fill the viewport.
export function heroArtworkKind(width, height) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) return '';
  const ratio = width / height;
  if (width >= 960 && height >= 480 && ratio >= 1.4 && ratio <= 2.5) return 'backdrop';
  if (width >= 240 && height >= 320 && ratio >= 0.45 && ratio <= 0.85) return 'poster';
  return '';
}

const artworkRequests = new WeakMap();
export function setHeroArtwork(element, item, createImage = () => document.createElement('img')) {
  const sources = [...new Set([...(Array.isArray(item.backdrop) ? item.backdrop : [item.backdrop]), item.poster].map(artworkURL).filter(Boolean))];
  const signature = JSON.stringify(sources), previous = artworkRequests.get(element);
  if (previous?.signature === signature) return;
  const request = {signature};artworkRequests.set(element, request);
  element.replaceChildren();element.classList.remove('is-poster', 'is-backdrop');
  function next(index) {
    if (artworkRequests.get(element) !== request || index >= sources.length) return;
    const picture = createImage();picture.alt = '';picture.decoding = 'async';picture.loading = 'eager';
    picture.onload = () => {
      if (artworkRequests.get(element) !== request) return;
      const kind = heroArtworkKind(picture.naturalWidth, picture.naturalHeight);
      if (!kind) {next(index + 1);return;}
      element.classList.add(`is-${kind}`);element.replaceChildren(picture);
    };
    picture.onerror = () => next(index + 1);
    picture.src = sources[index];
  }
  next(0);
}

export function heroFacts(item, {previousDuration, durationPending = false} = {}) {
  const movie = movieWithPlaybackDuration(item, previousDuration);
  return [
    {label:'Ano', value:previewYear(movie)},
    {label:'Duração', value:previewText(movie.duration) || (durationPending ? 'Consultando…' : 'Não informada'), pending:durationPending && !previewText(movie.duration)},
    {label:'Avaliação', value:previewRating(movie)}
  ];
}

export function renderHeroFacts(element, item, options, node) {
  element.replaceChildren(...heroFacts(item, options).map(({label, value, pending}) => {
    const fact = node('span', 'hero-fact');
    fact.append(node('span', 'hero-fact-label', label), node('strong', 'hero-fact-value', value));
    if (pending) fact.setAttribute('aria-busy', 'true');
    return fact;
  }));
}
