import { findChannelVariants } from './player-tools.js';

const STALL_WINDOW_MS = 30_000;
const SWITCH_COOLDOWN_MS = 60_000;
const HEALTHY_PERIOD_MS = 90_000;
const MIN_PLAYBACK_MS = 2_000;
const MAX_HIGHER_ATTEMPTS = 2;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const idOf = item => String(item?.id ?? '');
const familyItem = item => ({ ...item, name: String(item?.name || '').replace(/\b(480|720|1080|2160)p?\b/gi, (_, pixels) => ({ 480: 'SD', 720: 'HD', 1080: 'FHD', 2160: '4K' })[pixels]) });

function qualityRank(name) {
  const ranks = new Set();
  const quality = /(?:^|[\s\[\]()._|-])(sd|hd|fhd|uhd|4k|480p?|720p?|1080p?|2160p?)(?=$|[\s\[\]()._|-])/gi;
  for (const match of String(name || '').matchAll(quality)) {
    const value = match[1].toLowerCase();
    ranks.add(/^(?:4k|uhd|2160p?)$/.test(value) ? 2160 : /^(?:fhd|1080p?)$/.test(value) ? 1080 : /^(?:hd|720p?)$/.test(value) ? 720 : 480);
  }
  // Ambiguous names cannot establish a reliable next quality step.
  return ranks.size === 1 ? [...ranks][0] : null;
}

export function createAdaptiveState({ now = 0, currentId = '' } = {}) {
  const time = finite(now) ? now : 0;
  return {
    currentId: String(currentId),
    startedAt: time,
    lastObservedAt: time,
    lastSwitchAt: null,
    lastStallCount: 0,
    stallTimes: [],
    healthySince: null,
    higherAttempts: 0,
    pendingId: null
  };
}

export function decideAdaptiveSource({ state, now, enabled, bufferSeconds, stalls, bandwidthBps, currentBitrateBps, variants = [], currentItem } = {}) {
  const next = state ? { ...state, stallTimes: [...(state.stallTimes || [])] } : createAdaptiveState({ now, currentId: idOf(currentItem) });
  const result = (reason, target = null) => ({ target, reason, state: next });
  if (!finite(now)) return result('clock-unavailable');
  if (currentItem?.kind !== 'live') return result('on-demand');
  const currentId = idOf(currentItem);
  if (!currentId) return result('source-unavailable');
  const previousObservation = next.lastObservedAt;
  if (now < previousObservation) {
    next.healthySince = null;
    next.stallTimes = [];
    next.lastObservedAt = now;
    return result('clock-reset');
  }
  next.lastObservedAt = now;

  // A decision is an attempt, not proof that the replacement has started.
  // Keep its cooldown and budget until the caller observes the new source.
  if (next.pendingId) {
    if (currentId === next.pendingId) next.pendingId = null;
    else if (now - next.lastSwitchAt < SWITCH_COOLDOWN_MS) return result('switch-pending');
    else next.pendingId = null;
  }
  if (currentId !== next.currentId) {
    next.currentId = currentId;
    next.startedAt = now;
    next.lastStallCount = Number.isInteger(stalls) && stalls >= 0 ? stalls : 0;
    next.stallTimes = [];
    next.healthySince = null;
    return result('source-changed');
  }

  const validStalls = Number.isInteger(stalls) && stalls >= 0;
  const previousStalls = next.lastStallCount;
  const newStalls = validStalls ? Math.max(0, stalls - previousStalls) : 0;
  if (validStalls) next.lastStallCount = stalls;
  const observationGap = now - previousObservation;
  if (!enabled || !finite(bufferSeconds) || bufferSeconds < 0 || !validStalls) {
    next.healthySince = null;
    next.stallTimes = [];
    return result(enabled ? 'metrics-unavailable' : 'disabled');
  }
  if (stalls < previousStalls || observationGap > STALL_WINDOW_MS) {
    next.stallTimes = [];
    next.healthySince = null;
  } else if (newStalls) {
    // The counter is polled; count only stalls observed within this window.
    next.stallTimes.push(...Array(Math.min(newStalls, 2)).fill(now));
  }
  next.stallTimes = next.stallTimes.filter(time => now - time <= STALL_WINDOW_MS);
  if (newStalls || bufferSeconds < 15) next.healthySince = null;
  else if (next.healthySince === null) next.healthySince = now;

  if (now - next.startedAt < MIN_PLAYBACK_MS) return result('starting');
  if (next.lastSwitchAt !== null && now - next.lastSwitchAt < SWITCH_COOLDOWN_MS) return result('cooldown');
  const rank = qualityRank(currentItem.name);
  if (rank === null) return result('quality-unknown');
  const familyIds = new Set(findChannelVariants(familyItem(currentItem), variants.map(familyItem)).map(idOf));
  const offered = variants.filter(item => familyIds.has(idOf(item)))
    .map(item => ({ item, rank: qualityRank(item.name) }))
    .filter(option => option.rank !== null && idOf(option.item) !== currentId);
  const lower = offered.filter(option => option.rank < rank).sort((a, b) => b.rank - a.rank)[0]?.item;
  const higher = offered.filter(option => option.rank > rank).sort((a, b) => a.rank - b.rank)[0]?.item;
  let target = null;
  let reason = 'holding';
  if (bufferSeconds < 2 && next.stallTimes.length >= 2 && lower) {
    target = lower;
    reason = 'repeated-stalls';
  } else if (higher && next.higherAttempts < MAX_HIGHER_ATTEMPTS && next.healthySince !== null && now - next.healthySince >= HEALTHY_PERIOD_MS && finite(bandwidthBps) && bandwidthBps > 0 && finite(currentBitrateBps) && currentBitrateBps > 0 && bandwidthBps >= 2.5 * currentBitrateBps) {
    target = higher;
    reason = 'measured-headroom';
    next.higherAttempts++;
  }
  if (target) {
    next.pendingId = idOf(target);
    next.lastSwitchAt = now;
    next.healthySince = null;
    next.stallTimes = [];
  }
  return result(reason, target);
}
