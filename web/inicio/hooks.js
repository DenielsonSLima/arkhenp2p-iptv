import {latestReleases} from './ordens.js';
import {isPagedCatalog, pageChoices} from '../catalog-pagination.js';

// Initial preparation shares the pager's requests and concurrency budget.
// Its signal owns only these subscriptions, never a background completion.
export async function prepareHomeCatalogs({getCatalog, pager, isItemVisible = () => true, signal, target = 30, deadlineMs = 6000}) {
  const limit = Number.isInteger(target) && target >= 0 ? target : 30;
  const count = type => latestReleases((getCatalog(type)?.items || []).filter(isItemVisible), limit).length;
  const controller = new AbortController(), cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, {once: true});
  let settleAbort;
  const aborted = new Promise(resolve => { settleAbort = () => resolve(null); });
  controller.signal.addEventListener('abort', settleAbort, {once: true});
  if (controller.signal.aborted) settleAbort();
  const deadline = setTimeout(cancel, Number.isFinite(deadlineMs) && deadlineMs >= 0 ? deadlineMs : 6000);
  const cursor = catalog => JSON.stringify(catalog?.pagination?.byCategory || {});
  const prepare = async type => {
    while (!controller.signal.aborted) {
      const catalog = getCatalog(type), before = count(type);
      if (before >= limit || !isPagedCatalog(catalog) || !pageChoices(catalog).length) return;
      const beforeCursor = cursor(catalog);
      const loading = Promise.resolve().then(() => pager.load(type, '__all', {signal: controller.signal})).catch(() => null);
      const results = await Promise.race([loading, aborted]);
      if (controller.signal.aborted || results === null || Array.isArray(results) && (!results.length || results.some(result => result.status === 'rejected'))) return;
      if (count(type) <= before && cursor(getCatalog(type)) === beforeCursor) return;
    }
  };
  try {
    await Promise.all(['movies', 'series'].map(prepare));
    return {movies: count('movies'), series: count('series')};
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', settleAbort);
  }
}

/** Release the entry cover as soon as its view has usable data, or at the
 * deadline. Catalog work keeps its own lifetime and is never cancelled here. */
export function waitForEntryCatalog({tasks=[],isReady=()=>false,subscribe=()=>()=>{},signal,deadlineMs=1500}={}) {
  return new Promise(resolve=>{
    let settled=false,timer=null,unsubscribe=()=>{};
    const finish=reason=>{
      if(settled)return;settled=true;clearTimeout(timer);unsubscribe();
      signal?.removeEventListener('abort',cancel);resolve(reason);
    };
    const check=()=>{if(!settled&&isReady())finish('ready');};
    const cancel=()=>finish('cancelled');
    if(signal?.aborted){finish('cancelled');return;}
    signal?.addEventListener('abort',cancel,{once:true});
    unsubscribe=subscribe(check)||unsubscribe;
    timer=setTimeout(()=>finish('deadline'),Math.max(0,deadlineMs));
    for(const task of tasks)Promise.resolve(task).then(check,check);
    check();
  });
}
