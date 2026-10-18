const channelID = item => item?.kind === 'live' && item.id !== undefined && item.id !== null ? String(item.id) : null;
const cancelled = () => new DOMException('Esta troca de canal foi encerrada.', 'AbortError');

/** One confirmed target at a time. Metadata preserves the current stream;
 * media preparation may drain its local buffer before committing the handoff. */
export class ChannelSwitchController {
  constructor({view, service, getScope = () => null, getCurrent = () => null,
    getContext = item => ({item}), isAllowed = () => true, commit = () => {},
    onFailure = () => {}, onActivity = () => {}, subscribeProgram,primeMedia,prepareMedia,onRelease} = {}) {
    Object.assign(this, {view, service, getScope, getCurrent, getContext, isAllowed,
      commit, onFailure, onActivity, subscribeProgram,primeMedia,prepareMedia,onRelease});
    this.pending = null;
  }

  owns(ticket, item) {
    return Boolean(ticket && ticket === this.pending && !ticket.controller.signal.aborted
      && ticket.scope === this.getScope()
      && (item === undefined || channelID(item) === channelID(ticket.item)));
  }

  preserve(ticket) {
    return this.owns(ticket);
  }

  isPending() {
    return this.owns(this.pending);
  }

  context(ticket) {
    let context;
    try { context = this.getContext(ticket.item); } catch { context = null; }
    return {...context, item: ticket.item, phase: ticket.phase};
  }

  render(ticket, {show = false} = {}) {
    if (!this.owns(ticket)) return;
    const context = this.context(ticket);
    if (show) this.view?.show(context);
    else this.view?.update(context);
  }

  allowed(item) {
    try { return this.isAllowed(item) === true; } catch { return false; }
  }

  canCommit(ticket) {
    return this.owns(ticket) && this.getCurrent() === ticket.activeReference && this.allowed(ticket.item);
  }

  subscribe(ticket) {
    if (typeof this.subscribeProgram !== 'function') return;
    const unsubscribe = this.subscribeProgram(() => {
      if (this.pending !== ticket) return;
      if (!this.owns(ticket) || !this.allowed(ticket.item)) { this.cancel(); return; }
      this.render(ticket);
    },ticket.item);
    if (typeof unsubscribe !== 'function') return;
    if (this.pending === ticket) ticket.unsubscribe = unsubscribe;
    else unsubscribe();
  }

  select(item) {
    // Holding a channel key must not restart the same metadata read.
    if (this.owns(this.pending, item)) return this.pending.promise || Promise.resolve(true);
    this.cancel();
    const activeReference = this.getCurrent();
    if (!channelID(item) || channelID(activeReference?.item) === channelID(item) || !this.allowed(item)) return Promise.resolve(false);
    const ticket = {item, controller: new AbortController(), scope: this.getScope(),
      activeReference, phase: 'preparing', prepared: null, unsubscribe: null, promise: null};
    this.pending = ticket;
    try{
      this.primeMedia?.(item,ticket);
      this.onActivity(true);
      this.render(ticket, {show: true});
      this.subscribe(ticket);
    }catch(error){
      this.cancel();this.onFailure(error,{item,phase:ticket.phase});return Promise.resolve(false);
    }
    ticket.promise = this.prepare(ticket);
    return ticket.promise;
  }

  async prepare(ticket) {
    try {
      const prepared = await this.service.prepare(ticket.item, {signal: ticket.controller.signal});
      if (!this.canCommit(ticket)) throw cancelled();
      ticket.prepared = prepared;
      ticket.phase = 'connecting';
      this.render(ticket);
      if(this.prepareMedia){
        ticket.preparedVideo=await this.prepareMedia(ticket.item,ticket);
        if(!this.canCommit(ticket))throw cancelled();
      }
      await this.commit(ticket.item, {channelSwitchTicket: ticket, preparedLiveSources: prepared});
      // Commit may have replaced the player. From here ownership is checked
      // by ticket/scope; the original active reference is no longer expected.
      if (!this.owns(ticket)) {
        if (this.pending === ticket) this.cancel();
        return false;
      }
      return true;
    } catch (error) {
      if (this.pending !== ticket) return false;
      const report = this.owns(ticket) && !ticket.controller.signal.aborted && error?.name !== 'AbortError';
      const phase = ticket.phase;
      this.cancel();
      if (report) this.onFailure(error, {item: ticket.item, phase});
      return false;
    }
  }

  matchesPlayer(player) {
    const ticket = this.pending;
    return this.owns(ticket) && ticket.phase === 'connecting'
      && player?.channelSwitchTicket === ticket && channelID(player.item) === channelID(ticket.item);
  }

  finish(player) {
    if (!this.matchesPlayer(player)) return false;
    // Completion releases UI ownership only. Its signal must not cancel the
    // source that the normal player has just attached.
    return this.release(this.pending, {abort: false});
  }

  markPlaying(player) { return this.finish(player); }
  markReady(player) { return this.finish(player); }
  markFailure(player) { return this.finish(player); }

  release(ticket, {abort = true} = {}) {
    if (!ticket || this.pending !== ticket) return false;
    this.pending = null;
    if (abort) ticket.controller.abort();
    this.onRelease?.(ticket,{abort});
    const unsubscribe = ticket.unsubscribe;
    ticket.unsubscribe = null;
    const current = this.getCurrent();
    if (current?.channelSwitchTicket === ticket) current.channelSwitchTicket = null;
    ticket.activeReference = null;
    ticket.prepared = null;
    ticket.preparedVideo = null;
    ticket.promise = null;
    unsubscribe?.();
    this.view?.hide();
    this.onActivity(false);
    return true;
  }

  cancel({preserveTicket} = {}) {
    if (this.preserve(preserveTicket)) return false;
    if (!this.pending) { this.view?.hide(); return false; }
    return this.release(this.pending);
  }
}
