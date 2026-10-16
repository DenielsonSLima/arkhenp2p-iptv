const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function retry(policy, fallback) {
  const value = policy?.default;
  return {maxAttempts: 1, timeout: positive(value?.maxLoadTimeMs) ? value.maxLoadTimeMs : fallback,
    connectionTimeout: positive(value?.maxTimeToFirstByteMs) ? value.maxTimeToFirstByteMs : fallback};
}

/** Only options with a public Shaka counterpart are translated. The shared
 * controller owns retries; Shaka must not independently reopen a rejected source. */
export function shakaConfiguration(config, {loaded = false, abrEnabled = true} = {}) {
  const goal = positive(config.maxBufferLength) ? config.maxBufferLength : 30;
  return {
    abr: {enabled: abrEnabled},
    manifest: {retryParameters: retry(loaded ? config.playlistLoadPolicy : config.manifestLoadPolicy, loaded ? 8000 : 60000)},
    streaming: {
      bufferingGoal: goal,
      rebufferingGoal: Math.min(2, goal),
      bufferBehind: positive(config.backBufferLength) ? config.backBufferLength : 30,
      lowLatencyMode: config.lowLatencyMode === true,
      preferNativeHls: false,
      useNativeHlsForFairPlay: false,
      allowMediaSourceRecoveries: false,
      preloadNextUrlWindow: 0,
      retryParameters: retry(config.fragLoadPolicy, 15000),
      failureCallback: () => {}
    }
  };
}
