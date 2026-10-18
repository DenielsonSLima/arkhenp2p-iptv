// Cold OTT account metadata already has a total 40-second backend deadline.
// Match that preparation budget; cancellation of a newer intent stays immediate.
export const TV_SOURCE_DISCOVERY_TIMEOUT_MS=40000;

/** Source descriptors do not open media. Resolve them while the previous
 * decoder/provider drains; callers may attach media only after both finish. */
export async function prepareTVOpening({prepare, stopped = [], signal, onPhase} = {}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const measured = phase => { try { onPhase?.(phase); } catch {} };
  const sources = Promise.resolve().then(() => {
    combined.throwIfAborted();
    return prepare({signal: combined});
  }).then(value => { measured('sources'); return {value}; }, error => { measured('sources'); return {error}; });
  try {
    try { await Promise.all(stopped); }
    catch (cause) {
      controller.abort();
      throw Object.assign(new Error('Não foi possível encerrar a reprodução anterior.'),
        {code: 'LIVE_PREVIOUS_STOP_FAILED', cause});
    } finally { measured('stopped'); }
    const result = await sources;
    if (result.error) throw result.error;
    combined.throwIfAborted();
    return result.value;
  } finally { controller.abort(); }
}
