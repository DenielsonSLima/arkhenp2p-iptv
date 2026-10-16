/** Prepares only the public source descriptors. The existing playback routes
 * still own the media connection, provider selection and STOP sequence. */
export class ChannelSwitchService {
  constructor({preparePlayback} = {}) {
    this.preparePlayback = preparePlayback;
  }

  async prepare(item, {signal} = {}) {
    if (typeof this.preparePlayback !== 'function') throw new TypeError('TV_PLAYBACK_PREPARATION_REQUIRED');
    const deadline = AbortSignal.timeout(4000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      const prepared = await this.preparePlayback(item, {signal: combined});
      combined.throwIfAborted();
      return prepared;
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) {
        throw new DOMException('A preparação deste canal demorou demais. Tente novamente.', 'TimeoutError');
      }
      throw error;
    }
  }
}
