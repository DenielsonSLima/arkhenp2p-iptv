let registrySequence = 0;
const identity = cloud => {
  const scope = cloud?.scope;
  return cloud?.ready && cloud.client && /^[a-f0-9-]{36}$/i.test(scope?.userId || '')
    && scope.providerKey && scope.scopeHash ? JSON.stringify([scope.userId, scope.providerKey, scope.scopeHash]) : null;
};

/** One registry channel on CloudLibrary's existing SDK/socket/Auth. Only an
 * owner-scoped revision is observed; no watch statistics or playback data. */
export class HomeTVRealtime {
  constructor({getCloud = () => null, onChange = () => {}} = {}) {
    Object.assign(this, {getCloud, onChange});
    this.epoch = 0;
    this.channelId = ++registrySequence;
    this.key = null;
    this.client = null;
    this.channel = null;
    this.revision = null;
    this.subscribed = false;
    this.queued = null;
    this.disposed = false;
  }

  #notify(event) {
    if (this.queued) { this.queued.event = event; return; }
    const ticket = {epoch: this.epoch, key: this.key, event};
    this.queued = ticket;
    queueMicrotask(() => {
      if (this.queued !== ticket) return;
      this.queued = null;
      if (!this.disposed && ticket.epoch === this.epoch && ticket.key === identity(this.getCloud())) this.onChange(ticket.event);
    });
  }

  sync() {
    if (this.disposed) return;
    const cloud = this.getCloud(), key = identity(cloud);
    if (key && key === this.key && cloud.client === this.client && this.channel) return;
    void this.reset();
    if (!key) return;
    const {client, scope} = cloud, epoch = this.epoch;
    this.key = key;
    this.client = client;
    const current = () => !this.disposed && this.epoch === epoch && this.client === client && identity(this.getCloud()) === key;
    // Installed realtime-js reuses an existing topic until unsubscribe settles.
    // A new epoch must not accidentally resubscribe its retiring channel.
    const channel = client.channel(`arkhen-home-tv:${scope.userId}:${scope.providerKey}:${scope.scopeHash}:${this.channelId}:${epoch}`);
    for (const event of ['INSERT', 'UPDATE']) channel.on('postgres_changes', {
      event, schema: 'public', table: 'user_tv_watch_versions', filter: `user_id=eq.${scope.userId}`,
    }, payload => {
      if (!current()) return;
      const row = payload?.new;
      if (row?.user_id !== scope.userId || row.provider_key !== scope.providerKey || row.scope_hash !== scope.scopeHash
        || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision === this.revision) return;
      this.revision = row.revision;
      this.#notify({reason: 'revision', revision: row.revision});
    });
    this.channel = channel.subscribe(status => {
      if (!current()) return;
      if (status === 'SUBSCRIBED') {
        const reconnect = this.subscribed;
        this.subscribed = true;
        // Rejoin does not replay missed rows. The model retains its request
        // cooldown; socket state never creates its own API retry loop.
        this.#notify({reason: reconnect ? 'reconnect' : 'subscribed'});
      }
    });
  }

  reset() {
    this.epoch++;
    this.queued = null;
    const {client, channel} = this;
    this.client = this.channel = null;
    this.key = this.revision = null;
    this.subscribed = false;
    try { return Promise.resolve(channel && client?.removeChannel(channel)).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  dispose() { this.disposed = true; return this.reset(); }
}
