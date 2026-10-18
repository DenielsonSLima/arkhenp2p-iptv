const CHECK_MS = 5_000;
const sessionPath = path => typeof path === 'string' ? path.split(/[?#]/, 1)[0] : '';
const excluded = path => ['/api/login', '/api/logout'].includes(sessionPath(path));
const required = error => error?.status === 401 && error.code === 'SESSION_REQUIRED';
const accountId = value => typeof value === 'string' && value.trim() ? value : null;

/** Reconcile the local UI only after definitive same-origin session evidence.
 * Scope must include the caller's account and connection generation. Checks
 * are event-driven, bounded and coalesced; this never logs out remotely. */
export class SessionGuard {
  constructor({request, getScope, onLost, getAccountId = () => null, now = () => Date.now()} = {}) {
    if (![request, getScope, onLost, getAccountId, now].every(value => typeof value === 'function')) {
      throw new TypeError('A guarda de sessão requer transporte, escopo e callback.');
    }
    this.rawRequest = request; this.getScope = getScope; this.onLost = onLost; this.getAccountId = getAccountId; this.now = now;
    this.epoch = 0; this.pending = null; this.lastCheck = null; this.lost = null;
  }

  capture() {
    const value = this.getScope();
    return {scope: typeof value === 'string' && value ? value : null, epoch: this.epoch, expectedAccount: accountId(this.getAccountId())};
  }

  current(token) {
    return token.scope !== null && token.epoch === this.epoch && token.scope === this.getScope();
  }

  lose(token, reason) {
    if (!this.current(token) || this.lost?.scope === token.scope && this.lost.epoch === token.epoch) return;
    // Mark before calling UI code: it may synchronously reset this guard or
    // begin another connection, invalidating every older response.
    this.lost = token;
    try { Promise.resolve(this.onLost({scope: token.scope, reason})).catch(() => {}); }
    catch { /* UI callback failure must not replace the original API result. */ }
  }

  observeSession(body, token) {
    if (body?.error) return;
    if (body?.connected === false) this.lose(token, 'session-disconnected');
    else if (body?.connected === true && token.expectedAccount && accountId(body.account?.libraryId)
      && body.account.libraryId !== token.expectedAccount) this.lose(token, 'session-changed');
  }

  async request(path, options = {}) {
    const token = this.capture();
    try {
      const body = await this.rawRequest(path, options);
      if (sessionPath(path) === '/api/session') this.observeSession(body, token);
      return body;
    } catch (error) {
      if (!excluded(path) && this.current(token)) {
        if (required(error)) this.lose(token, 'session-required');
        else if (error?.status === 401) await this.verify(token);
      }
      throw error;
    }
  }

  check() { return this.verify(this.capture()); }

  verify(token) {
    if (!this.current(token) || this.lost?.scope === token.scope && this.lost.epoch === token.epoch) return Promise.resolve(null);
    if (this.pending?.scope === token.scope && this.pending.epoch === token.epoch) return this.pending.promise;
    const now = this.now();
    if (this.lastCheck?.scope === token.scope && this.lastCheck.epoch === token.epoch && now - this.lastCheck.at < CHECK_MS) return Promise.resolve(null);
    this.pending?.controller.abort();
    const operation = {...token, controller: new AbortController(), promise: null};
    this.pending = operation; this.lastCheck = {...token, at: now};
    const {signal} = operation.controller;
    let timer, aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => reject(signal.reason || new DOMException('Verificação cancelada.', 'AbortError'));
      signal.addEventListener('abort', aborted, {once: true});
      timer = setTimeout(() => operation.controller.abort(new DOMException('Verificação de sessão demorou.', 'TimeoutError')), CHECK_MS);
    });
    const response = Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return this.rawRequest('/api/session', {signal});
    });
    operation.promise = (async () => {
      try {
        const body = await Promise.race([response, cancellation]);
        this.observeSession(body, token);
        return this.current(token) ? body : null;
      } catch (error) {
        if (required(error)) this.lose(token, 'session-required');
        return null;
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (this.pending === operation) this.pending = null;
      }
    })();
    return operation.promise;
  }

  reset() {
    this.epoch++;
    const pending = this.pending;
    this.pending = null; this.lastCheck = null; this.lost = null;
    pending?.controller.abort();
  }
}
