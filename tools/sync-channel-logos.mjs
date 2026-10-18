#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readWplayCredentials, safeCode } from './wplay-tool-input.mjs';
import { WplayOTTProviderClient } from '../lib/wplay/ott/provedor.mjs';
import { WplayProviderClient, WPLAY_AUTH_URLS } from '../lib/wplay/conexao/provedor-nativo.mjs';
import { requestUpstream, readBody } from '../lib/upstream.mjs';

const OUTPUT = fileURLToPath(new URL('../web/assets/channels/', import.meta.url));
const OPTIMIZER = fileURLToPath(new URL('./optimize-channel-logos.py', import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024;
const CONCURRENCY = 4;
const TIMEOUT = 15000;
const APK_NATIVE = process.argv.includes('--apk-native');

async function download(source, client) {
  if (source.startsWith('data:')) {
    const match = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,([a-z\d+/=\r\n]+)$/i.exec(source);
    if (!match || match[1].length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw Object.assign(new Error(), { code: 'UNSUPPORTED_IMAGE' });
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > MAX_BYTES) throw Object.assign(new Error(), { code: 'IMAGE_TOO_LARGE' });
    return buffer;
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
  timer.unref?.();
  let response;
  try {
    response = await requestUpstream(source, { headers: client.upstreamHeaders?.(source) || { 'User-Agent': client.userAgent }, signal: controller.signal, timeout: TIMEOUT });
    if (response.status !== 200) throw Object.assign(new Error(), { code: 'HTTP_ERROR', status: response.status });
    if (!/^image\/(?:jpe?g|png|webp|gif|avif|bmp|tiff)(?:;|$)/i.test(String(response.headers['content-type'] || ''))) throw Object.assign(new Error(), { code: 'UNSUPPORTED_IMAGE' });
    if (Number(response.headers['content-length'] || 0) > MAX_BYTES) throw Object.assign(new Error(), { code: 'IMAGE_TOO_LARGE' });
    return await readBody(response, MAX_BYTES);
  } finally { clearTimeout(timer);response?.body.destroy(); }
}

async function runOptimizer(job, report) {
  await new Promise((resolve, reject) => {
    const child = spawn('python3', [OPTIMIZER, job, OUTPUT, report], { stdio: ['ignore', 'inherit', 'pipe'] });
    // Do not print input-parser output; a failed image may contain private data.
    child.stderr.resume();child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(), { code: 'OPTIMIZER_FAILED' })));
  });
}

async function atomicJSON(filename, value) {
  const destination = path.join(OUTPUT, filename), temporary = destination + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');await rename(temporary, destination);
}

function catalogSchema(payload) {
  const schema = Object.fromEntries(['live', 'movie', 'series', 'episode'].map(kind => [kind, { count: 0, fields: {} }]));
  const collect = (kind, entry) => {
    if (!entry || typeof entry !== 'object') return;
    schema[kind].count++;
    for (const key of Object.keys(entry)) if (/^[a-z_][a-z\d_]{0,63}$/i.test(key)) schema[kind].fields[key] = (schema[kind].fields[key] || 0) + 1;
  };
  for (const row of payload.rows) for (const item of Array.isArray(row.items) ? row.items : []) {
    const kind = ({ Canal: 'live', Filme: 'movie', 'Série': 'series' })[item.kind || row.kind];
    if (!kind) continue;collect(kind, item);
    if (kind === 'series') {
      const entries = Array.isArray(item.episodes) ? item.episodes : Object.values(item.episodes || {}).flat();
      for (const episode of entries) collect('episode', episode);
    }
  }
  return schema;
}

function nativeSchema(items, service = {}) {
  const channelFields = {}, sourceFields = {}, schemes = { http: 0, https: 0, tvbus: 0, bts: 0, other: 0, missing: 0 };
  const fields = (target, object) => { for (const key of Object.keys(object || {})) if (/^[a-z_][a-z\d_]{0,63}$/i.test(key)) target[key] = (target[key] || 0) + 1; };
  for (const item of items) {
    fields(channelFields, item);
    for (const source of Array.isArray(item.sources) ? item.sources : []) {
      fields(sourceFields, source);
      const scheme = typeof source.address === 'string' ? /^([a-z][a-z\d+.-]*):/i.exec(source.address)?.[1].toLowerCase() : null;
      schemes[!scheme ? 'missing' : Object.hasOwn(schemes, scheme) ? scheme : 'other']++;
    }
  }
  return { count: items.length, channelFields, sourceFields, sourceSchemes: schemes, serviceFields: Object.keys(service).filter(key => /^[a-z_][a-z\d_]{0,63}$/i.test(key)) };
}

async function main() {
  const auth = await readWplayCredentials();
  // Native logo retrieval is an explicit mode with exactly one approved APK
  // auth destination. It never triggers credential replay to the primary URL.
  const client = APK_NATIVE ? new WplayProviderClient({ authURLs: [WPLAY_AUTH_URLS[1]], ...auth }) : new WplayOTTProviderClient({ server: 'https://player.wplayott.com', ...auth });
  // Credentials remain in memory only. No config file or environment export.
  auth.username = '';auth.password = '';
  let temporary;
  try {
    await client.connect();
    const catalog = await client.catalog('live'), groups = new Map(), failures = [];
    if (!catalog.items.length) throw Object.assign(new Error(), { code: 'EMPTY_CHANNEL_CATALOG' });
    for (const item of catalog.items) {
      const ref = item.poster ? new URL(item.poster, 'http://local.invalid').searchParams.get('ref') : null;
      const raw = client.rawItems.get('live:' + item.id);
      const source = client.images.get(ref) || [raw?.image, raw?.image_logo, raw?.logo?.image?.big, raw?.logo?.image?.full, raw?.logo?.image?.small].find(value => typeof value === 'string' && value.startsWith('data:'));
      if (!source) { failures.push({ ids: [String(item.id)], names: [item.name], reason: 'NO_IMAGE_SOURCE' });continue; }
      if (!groups.has(source)) groups.set(source, { index: groups.size, ids: new Set(), names: new Set(), source });
      groups.get(source).ids.add(String(item.id));groups.get(source).names.add(item.name);
    }
    const queue = [...groups.values()], downloaded = [];
    const sourceGroups = queue.map(group => ({ index: group.index, ids: [...group.ids], names: [...group.names] }));
    temporary = await mkdtemp(path.join(tmpdir(), 'wplay-channel-logos-'));
    await mkdir(OUTPUT, { recursive: true });
    console.log(JSON.stringify({ phase: 'catalog', channels: catalog.items.length, sourceGroups: queue.length, channelsWithoutSource: failures.length }));
    let cursor = 0, completed = 0, sourceBytes = 0;
    const progress = setInterval(() => console.log(JSON.stringify({ phase: 'download', completed, total: queue.length, succeeded: downloaded.length, failed: failures.filter(entry => entry.reason !== 'NO_IMAGE_SOURCE').length })), 10000);
    progress.unref?.();
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const index = cursor++;if (index >= queue.length) return;
          const group = queue[index];
          try {
            const buffer = await download(group.source, client), input = path.join(temporary, `source-${group.index}.bin`);
            await writeFile(input, buffer);sourceBytes += buffer.length;
            downloaded.push({ ...sourceGroups[index], input });
          } catch (error) {
            failures.push({ ...sourceGroups[index], reason: safeCode(error), ...(Number.isInteger(error.status) ? { status: error.status } : {}) });
          } finally { completed++; }
        }
      }));
    } finally { clearInterval(progress); }
    downloaded.sort((first, second) => first.index - second.index);
    const job = path.join(temporary, 'job.json'), report = path.join(temporary, 'optimized.json');
    await writeFile(job, JSON.stringify({ sources: downloaded }));
    console.log(JSON.stringify({ phase: 'optimize', downloaded: downloaded.length, sources: queue.length }));
    await runOptimizer(job, report);
    const optimized = JSON.parse(await readFile(report, 'utf8'));
    for (const failure of optimized.failures) failures.push({ ...sourceGroups[failure.index], reason: failure.reason });
    const covered = new Set(optimized.channels.flatMap(record => record.ids));
    const reasons = {};for (const failure of failures) reasons[failure.reason] = (reasons[failure.reason] || 0) + 1;
    const stats = {
      sourceProvider: APK_NATIVE ? 'wplay-p2p-apk-11.9.0d' : 'wplay-ott', idNamespace: APK_NATIVE ? 'native-channel-id' : 'ott-normalized-id',
      generatedAt: new Date().toISOString(), catalogChannels: catalog.items.length,
      sourceGroups: queue.length, channelsWithoutSource: failures.filter(entry => entry.reason === 'NO_IMAGE_SOURCE').length,
      downloadedSources: downloaded.length, failedDownloads: queue.length - downloaded.length,
      optimizedSources: optimized.sources.length, failedOptimizations: optimized.failures.length,
      uniqueLogos: optimized.channels.length, deduplicatedSources: optimized.sources.length - optimized.channels.length,
      channelsCovered: covered.size, channelsWithoutLocalLogo: catalog.items.length - covered.size,
      sourceBytes, optimizedBytes: optimized.optimizedBytes,
      maxDimension: 256, quality: 84, method: 6, concurrency: CONCURRENCY, downloadTimeoutMs: TIMEOUT,
      maxDownloadBytes: MAX_BYTES, failureReasons: reasons
    };
    await atomicJSON('manifest.json', { version: 1, channels: optimized.channels, stats });
    await atomicJSON('failures.json', { version: 1, failures });
    const readme = `# Logos reais dos canais WPLAY\n\nGerado em ${stats.generatedAt} a partir do catálogo ao vivo autorizado (${stats.sourceProvider}). O manifesto cruza IDs desta origem e nomes exatos, incluindo variantes de qualidade, sem associação aproximada entre canais ou afiliadas. IDs do APK e do portal OTT usam espaços diferentes; a associação entre essas origens exige nome exato e inequívoco.\n\n- Canais no catálogo: ${stats.catalogChannels}\n- Canais com logo local: ${stats.channelsCovered}\n- Fontes de imagem distintas: ${stats.sourceGroups}\n- Downloads concluídos: ${stats.downloadedSources}\n- Arquivos WebP únicos: ${stats.uniqueLogos}\n- Fontes deduplicadas por bytes WebP idênticos: ${stats.deduplicatedSources}\n- Bytes originais baixados: ${stats.sourceBytes}\n- Bytes WebP únicos: ${stats.optimizedBytes}\n- Canais sem logo local: ${stats.channelsWithoutLocalLogo}\n\nAs imagens mantêm transparência e proporção, sem fundo adicional. O maior lado tem no máximo 256 pixels, sem ampliar logos menores. WebP usa quality 84 e method 6. Imagens animadas usam o primeiro frame.\n\nOs downloads são agrupados pela fonte exata e limitados a quatro conexões simultâneas, 15 segundos e 5 MB por imagem. Arquivos sem fonte ou com falha estão em failures.json; nenhum logo alternativo foi inventado.\n\nReexecutar na raiz do projeto:\n\n\`\`\`sh\nnode tools/sync-channel-logos.mjs${APK_NATIVE ? ' --apk-native' : ''}\n\`\`\`\n\nInformar uma única linha JSON via stdin com os campos username e password. O terminal desativa o eco durante a leitura. O script não grava credenciais, cookies, tokens ou URLs de origem no manifesto, nos assets ou no relatório. Os downloads temporários da própria execução são removidos ao finalizar. Não são baixados vídeos, filmes ou cartazes.\n\nO modo --apk-native usa somente o servidor de autenticação alternativo autorizado do APK, uma vez, sem tentativa automática em outro servidor. A consulta de catálogo e logos não instala nem executa a engine P2P e não implica compatibilidade de reprodução no navegador. Nenhum logout remoto é executado.\n`;
    await writeFile(path.join(OUTPUT, 'README.md'), readme);
    console.log(JSON.stringify({ phase: 'complete', ...stats, manifest: 'web/assets/channels/manifest.json' }));
    if (APK_NATIVE) {
      console.log(JSON.stringify({ phase: 'native-live-schema', schema: nativeSchema([...client.rawItems.values()], client.authInfo?.service) }));
      if (process.argv.includes('--inspect-vod')) {
        try { console.log(JSON.stringify({ phase: 'native-vod-schema', schema: nativeSchema(await client.loadVOD(), client.authInfo?.service) })); }
        catch(error) { console.log(JSON.stringify({ phase: 'native-vod-schema', code: safeCode(error), status: error.status || null })); }
      }
    } else console.log(JSON.stringify({ phase: 'catalog-schema', schema: catalogSchema(await client.rawCatalog()) }));
  } finally {
    // No stream was started. Clear this tool's private state without asking the
    // provider to revoke a session that may also be used by the open player.
    client.session = null;
    client.config.username = '';client.config.password = '';client.authInfo = null;
    if (client.rpc) { client.rpc.cookieJar.clear();client.rpc.accessToken = null;client.refreshToken = null; }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes('--help')) {
  console.log('Uso: node tools/sync-channel-logos.mjs [--apk-native] [--inspect-vod]\nEntrada: uma linha JSON via stdin com username e password.\nSaída: web/assets/channels/manifest.json, failures.json e logos WebP.\n--apk-native: um único login no servidor alternativo autorizado do APK, sem fallback de autenticação.\n--inspect-vod: somente campos/contagens de metadados VOD; nunca mídia.\nSomente logos do catálogo ao vivo são baixados; nenhuma transmissão/logout remoto é iniciada.');
} else main().catch(error => { console.error(JSON.stringify({ phase: 'failed', code: safeCode(error) }));process.exitCode = 1; });
