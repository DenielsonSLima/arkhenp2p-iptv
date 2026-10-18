import {withRequestSignals} from '../../request-signals.js';
import {tvScope, tvScopeKey} from '../../tv/scope.js';
import {HomeTVServices} from './services.js';
import {homeTVFailure} from './contrato.js';

const blank = () => ({data: null, loading: false, waiting: false, error: null});
const keyOf = value => JSON.stringify(value ?? null);

/** Cache the four server-selected channels. Account/visibility changes discard
 * data; an outage retains that scope's last DTO, with no render-driven loop. */
export class HomeTVModel {
  constructor({request, services, getScope = () => null, getRevision = () => '', isActive = () => true, isAvailable = () => true,
    onChange = () => {}, loadQueryCore = () => import('/assets/vendor/cloud-client.js'), now = Date.now} = {}) {
    Object.assign(this, {getScope, getRevision, isActive, isAvailable, onChange, loadQueryCore, now});
    this.services = services || new HomeTVServices({request});
    this.state = blank();
    this.scope = null;
    this.loadedRevision = null;
    this.dirty = 0;
    this.loadedDirty = -1;
    this.epoch = 0;
    this.pending = null;
    this.timer = null;
    this.lastAttemptAt = null;
    this.lastLoadedAt = null;
    this.cooldownUntil = 0;
    this.rateLimitedUntil = 0;
    this.client = null;
    this.clientPromise = null;
    this.disposed = false;
  }

  async queries() {
    if (!this.clientPromise) this.clientPromise = Promise.resolve().then(() => this.loadQueryCore()).then(({QueryClient}) => {
      if (this.disposed) return null;
      return this.client = new QueryClient({defaultOptions: {queries: {retry: 0, staleTime: 30000,
        gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, structuralSharing: false}}});
    }).catch(() => null);
    return this.clientPromise;
  }

  ensure({force = false} = {}) {
    if (this.disposed) return;
    const scope = tvScope(this.getScope()), scopeKey = tvScopeKey(scope);
    if (!scopeKey) { if (this.scope !== null) this.reset(); return; }
    if (this.scope !== scopeKey) { this.reset(); this.scope = scopeKey; }
    // A cloud bootstrap failure does not end the signed-in account or erase
    // its last four-card projection. Wait without issuing an impossible RPC;
    // reconnect/retry belongs to the application's existing cloud bridge.
    if (!this.isAvailable()) {
      clearTimeout(this.timer); this.timer = null;
      if (this.pending) {
        this.epoch++; this.pending.controller.abort(); this.pending = null;
      }
      if (!this.state.waiting || this.state.loading || this.state.error) {
        this.state = {...this.state, loading: false, waiting: true, error: null};
        this.onChange(this.state);
      }
      return;
    }
    if (this.state.waiting) {
      this.state = {...this.state, waiting: false};
      this.onChange(this.state);
    }
    if (!this.isActive() || this.pending) return this.pending?.promise;
    const now = this.now(), revision = keyOf(this.getRevision());
    if (now < this.rateLimitedUntil || !force && now < this.cooldownUntil) return;
    // A rolling seven-day winner can change without a new watch revision.
    // Recheck on the next active ensure after a minute; no polling is added.
    if (!force && this.state.data && !this.state.error && this.loadedRevision === revision && this.loadedDirty === this.dirty
      && this.lastLoadedAt !== null && now - this.lastLoadedAt < 60000) return;
    if (force) { clearTimeout(this.timer); this.timer = null; }
    const wait = force || this.lastAttemptAt === null ? 0 : Math.max(0, this.lastAttemptAt + 15000 - now);
    if (wait) {
      if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.ensure(); }, wait);
      return;
    }
    return this.#load(scope, scopeKey, revision, force);
  }

  #load(scope, scopeKey, revision, force) {
    const job = {controller: new AbortController(), epoch: this.epoch, dirty: this.dirty, promise: null};
    this.pending = job;
    this.lastAttemptAt = this.now();
    this.state = {...this.state, loading: true, waiting: false, error: null};
    this.onChange(this.state);
    const current = () => !this.disposed && this.pending === job && job.epoch === this.epoch
      && !job.controller.signal.aborted && tvScopeKey(this.getScope()) === scopeKey;
    job.promise = (async () => {
      let sdkTimer;
      try {
        const client = await Promise.race([this.queries(), new Promise(resolve => { sdkTimer = setTimeout(() => resolve(null), 500); })]);
        clearTimeout(sdkTimer);
        if (!current()) return;
        const queryKey = ['arkhen-home-tv', scopeKey, revision, job.dirty];
        const run = ({signal} = {}) => withRequestSignals([signal, job.controller.signal],
          combined => this.services.home(scope, {signal: combined}));
        const value = client ? await client.fetchQuery({queryKey, queryFn: run, staleTime: force ? 0 : 30000}) : await run();
        if (!current()) return;
        this.loadedRevision = revision;
        this.loadedDirty = job.dirty;
        this.lastLoadedAt = this.now();
        this.cooldownUntil = this.rateLimitedUntil = 0;
        this.state = {data: value, loading: false, waiting: false, error: null};
        const queries = client?.getQueryCache().getAll() || [];
        for (const query of queries.slice(0, Math.max(0, queries.length - 4))) client.removeQueries({queryKey: query.queryKey, exact: true});
      } catch (error) {
        if (!current()) return;
        const safe = homeTVFailure(error);
        this.cooldownUntil = this.now() + Math.max(30000, (safe.retryAfterSeconds || 0) * 1000);
        if (safe.status === 429) this.rateLimitedUntil = this.cooldownUntil;
        this.state = {...this.state, loading: false, error: safe};
      } finally {
        clearTimeout(sdkTimer);
        if (this.pending === job) {
          this.pending = null;
          if (job.epoch === this.epoch && tvScopeKey(this.getScope()) === scopeKey) {
            this.state = {...this.state, loading: false};
            this.onChange(this.state);
            if (!this.state.error && (job.dirty !== this.dirty || revision !== keyOf(this.getRevision()))) this.ensure();
          }
        }
      }
    })();
    return job.promise;
  }

  invalidate() {
    this.dirty++;
    void this.client?.invalidateQueries({queryKey: ['arkhen-home-tv'], refetchType: 'none'});
  }

  pause() {
    this.epoch++;clearTimeout(this.timer);this.timer=null;
    this.pending?.controller.abort();this.pending=null;
    this.state={...this.state,loading:false};
    void this.client?.cancelQueries({queryKey:['arkhen-home-tv']});
  }

  reset() {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending?.controller.abort();
    this.pending = null;
    this.scope = null;
    this.loadedRevision = null;
    this.lastAttemptAt = null;
    this.lastLoadedAt = null;
    this.cooldownUntil = this.rateLimitedUntil = 0;
    this.loadedDirty = -1;
    this.state = blank();
    void this.client?.cancelQueries();
    this.client?.clear();
  }

  dispose() { this.disposed = true; this.reset(); }
}
