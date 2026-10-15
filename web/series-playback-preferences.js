export const SERIES_PLAYBACK_DEFAULTS = Object.freeze({autoNext:true, autoSkipOpening:true, nextMode:'offset', endOffsetSeconds:30});
export const SERIES_NEXT_MODES = Object.freeze(['offset', 'markers', 'ended']);
export const SERIES_COUNTDOWN_SECONDS = 5;
const STORAGE_KEY = 'arkhen.series-playback.v1';
const browserStorage = () => {try {return globalThis.localStorage;} catch {return null;}};

export function normalizeSeriesPlaybackPreferences(value = {}) {
  return {
    autoNext:typeof value?.autoNext === 'boolean' ? value.autoNext : SERIES_PLAYBACK_DEFAULTS.autoNext,
    autoSkipOpening:typeof value?.autoSkipOpening === 'boolean' ? value.autoSkipOpening : SERIES_PLAYBACK_DEFAULTS.autoSkipOpening,
    nextMode:SERIES_NEXT_MODES.includes(value?.nextMode) ? value.nextMode : SERIES_PLAYBACK_DEFAULTS.nextMode,
    endOffsetSeconds:Number.isInteger(value?.endOffsetSeconds) && value.endOffsetSeconds >= 5 && value.endOffsetSeconds <= 300
      ? value.endOffsetSeconds : SERIES_PLAYBACK_DEFAULTS.endOffsetSeconds
  };
}

/** Device preferences contain no account identifiers, episode URLs or tokens. */
export class SeriesPlaybackPreferences {
  constructor({storage = browserStorage(), getNamespace = () => ''} = {}) {
    this.storage=storage;this.getNamespace=getNamespace;this.listeners=new Set();this.value={...SERIES_PLAYBACK_DEFAULTS};
    try {
      const raw=storage?.getItem(STORAGE_KEY);
      if(raw && raw.length<=4096){const saved=JSON.parse(raw);if(saved?.version===1)this.value=normalizeSeriesPlaybackPreferences(saved.preferences);}
    } catch {/* Preferences still work for this session when storage is blocked. */}
  }
  getPreferences() {return {...this.value};}
  setPreferences(patch = {}) {
    this.value=normalizeSeriesPlaybackPreferences({...this.value,...(patch && typeof patch==='object'?patch:{})});
    try {this.storage?.setItem(STORAGE_KEY,JSON.stringify({version:1,preferences:this.value}));} catch {/* Session-only fallback. */}
    for(const listener of this.listeners)listener(this.getPreferences());
    return this.getPreferences();
  }
  subscribe(listener) {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
}
