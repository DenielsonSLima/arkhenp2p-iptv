import {isAdultItem} from '../../parental-classification.js';

export const channelID = value => /^\d{1,12}$/.test(String(value ?? '')) ? String(value) : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const revision = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => Object.assign(new Error('Não foi possível atualizar seus canais.'), {code: 'HOME_TV_RESPONSE_INVALID'});

/** Validate public shape and server order; never rank, fill or rename a channel. */
export function homeTVReply(value) {
  if (value?.schemaVersion !== 1 || value.source !== 'rpc' || !revision(value.revision)
    || !timestamp(value.generatedAt) || !/^[a-f0-9-]{36}$/i.test(value.snapshotVersion || '')
    || !Array.isArray(value.items) || value.items.length > 4) throw invalid();
  const most = value.mostWatchedId === null ? null : channelID(value.mostWatchedId);
  if (value.mostWatchedId !== null && !most) throw invalid();
  const seen = new Set();
  let recent = 0, featured = 0;
  for (const [index, entry] of value.items.entries()) {
    const item = entry?.item, id = channelID(item?.id);
    if (!id || item?.kind !== 'live' || item.isAdult !== false || isAdultItem(item)
      || typeof item.name !== 'string' || !item.name.trim() || seen.has(id)
      || !Number.isSafeInteger(entry.watchedSeconds) || entry.watchedSeconds < 0
      || !timestamp(entry.lastWatchedAt)) throw invalid();
    seen.add(id);
    if (entry.reason === 'most-watched') {
      // The RPC selects positive milliseconds; its rounded seconds may be0.
      if (index !== 0 || id !== most || ++featured > 1) throw invalid();
    } else if (entry.reason !== 'recent' || ++recent > 3) throw invalid();
  }
  if (most && featured !== 1 || !most && featured) throw invalid();
  return value;
}

export function heartbeatReply(value) {
  if (value?.schemaVersion !== 1 || typeof value.accepted !== 'boolean'
    || !Number.isFinite(value.creditedSeconds) || value.creditedSeconds < 0 || value.creditedSeconds > 20
    || value.revision !== undefined && !revision(value.revision)) throw invalid();
  return value;
}

export function homeTVFailure(error) {
  return Object.assign(new Error('Não foi possível atualizar seus canais agora.'), {
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'HOME_TV_UNAVAILABLE',
    ...(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? {status: error.status} : {}),
    ...(Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0
      ? {retryAfterSeconds: Math.min(86400, error.retryAfterSeconds)} : {}),
  });
}

export function liveFilters(scope) {
  const read = value => {
    const ids = Array.isArray(value) ? value : value?.live || [];
    if (!Array.isArray(ids) || ids.length > 2000 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) {
      throw Object.assign(new Error('As preferências dos canais precisam ser atualizadas.'), {code: 'HOME_TV_FILTERS_INVALID'});
    }
    return [...new Set(ids)];
  };
  return {hidden: read(scope?.hidden), hiddenItems: read(scope?.hiddenItems)};
}
