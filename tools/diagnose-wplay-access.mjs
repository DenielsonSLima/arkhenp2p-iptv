#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { WplayOTTProviderClient, WPLAY_OTT_RPC } from '../lib/wplay/ott/provedor.mjs';
import { readWplayCredentials, safeCode, sanitizeWplayMessage } from './wplay-tool-input.mjs';

async function main() {
  const auth = await readWplayCredentials(), secrets = [auth.username, auth.password];
  const client = new WplayOTTProviderClient({ server: 'https://player.wplayott.com', ...auth });
  auth.username = '';auth.password = '';
  const original = client.rpc.call.bind(client.rpc), names = new Map(Object.entries(WPLAY_OTT_RPC).map(([name, id]) => [id, name]));
  client.rpc.call = async (id, options) => {
    const phase = names.get(id) || 'unknown', started = performance.now();
    try {
      const result = await original(id, options);
      console.log(JSON.stringify({
        phase, resultKeys: result && typeof result === 'object' ? Object.keys(result).filter(key => /^[a-z_][a-z\d_]{0,63}$/i.test(key)) : [],
        authenticated: typeof result?.authenticated === 'boolean' ? result.authenticated : null,
        message: sanitizeWplayMessage(result?.message, [...secrets, ...client.rpc.cookieJar.values(), client.rpc.accessToken, client.refreshToken]),
        elapsedMs: Math.round(performance.now() - started)
      }));
      return result;
    } catch (error) {
      console.log(JSON.stringify({ phase, code: safeCode(error), status: error.status || null, message: sanitizeWplayMessage(error.message, [...secrets, ...client.rpc.cookieJar.values(), client.rpc.accessToken, client.refreshToken]), elapsedMs: Math.round(performance.now() - started) }));
      throw error;
    }
  };
  try {
    await client.connect();
    const payload = await client.rawCatalog(), counts = { live: 0, movie: 0, series: 0, unknown: 0 };
    for (const row of payload.rows) for (const item of Array.isArray(row?.items) ? row.items : []) {
      const kind = ({ Canal: 'live', Filme: 'movie', 'Série': 'series' })[item?.kind || row?.kind] || 'unknown';counts[kind]++;
    }
    const live = await client.catalog('live');
    console.log(JSON.stringify({ phase: 'catalog-counts', rows: payload.rows.length, rawItems: counts, normalizedLiveItems: live.items.length, cookieCount: client.rpc.cookieJar.size, hasAccessToken: Boolean(client.rpc.accessToken) }));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'summary', connected: Boolean(client.session), code: safeCode(error), status: error.status || null }));
    process.exitCode = 1;
  } finally {
    // Diagnose only: no media, no remote logout, no credential/session files.
    client.session = null;client.config.username = '';client.config.password = '';client.rpc.cookieJar.clear();client.rpc.accessToken = null;client.refreshToken = null;secrets.fill('');
  }
}

if (process.argv.includes('--help')) console.log('Uso: node tools/diagnose-wplay-access.mjs\nEntrada: uma linha JSON username/password via stdin sem eco.\nSaída: campos de resposta, authenticated, mensagens sanitizadas e contagens.\nNão inicia transmissão, não grava dados privados e não executa logout remoto.');
else main().catch(error => { console.error(JSON.stringify({ phase: 'failed', code: safeCode(error) }));process.exitCode = 1; });
