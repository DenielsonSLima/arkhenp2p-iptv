import { requestUpstream, readBody, validUpstreamURL } from './upstream.mjs';

const SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_REQUESTS = 8;
const MAX_BYTES = 1024 * 1024;

function mvhdDuration(buffer) {
  const version = buffer[0];
  if (version !== 0 && version !== 1) return null;
  const minimum = version === 0 ? 20 : 32;
  if (buffer.length < minimum) return null;
  const timescale = buffer.readUInt32BE(version === 0 ? 12 : 20);
  const ticks = version === 0 ? BigInt(buffer.readUInt32BE(16)) : buffer.readBigUInt64BE(24);
  if (!timescale || !ticks || ticks === (version === 0 ? 0xffffffffn : 0xffffffffffffffffn)) return null;
  const scale = BigInt(timescale), whole = ticks / scale;
  if (whole > SAFE_BIGINT) return null;
  const seconds = Number(whole) + Number(ticks % scale) / timescale;
  return Number.isFinite(seconds) && seconds > 0 && seconds <= Number.MAX_SAFE_INTEGER ? seconds : null;
}

// Read MP4 box headers and mvhd only. Never download mdat or accept an upstream
// that ignores byte ranges. Every operation shares one deadline and byte budget.
export async function probeMP4Duration(value, { headers = {}, allowPrivate = false, signal, timeout = 6000 } = {}) {
  const initial = validUpstreamURL(value, allowPrivate);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  timer.unref?.();
  let target = initial, total = null, block, requests = 0, bytes = 0;
  const range = async (start, length) => {
    if (controller.signal.aborted || !Number.isSafeInteger(start) || start < 0) throw new Error('MP4 metadata budget exceeded.');
    const end = Math.min(start + length - 1, total === null ? Number.MAX_SAFE_INTEGER : total - 1);
    if (end < start || !Number.isSafeInteger(end)) throw new Error('Invalid MP4 range.');
    let response;
    for (;;) {
      if (++requests > MAX_REQUESTS || controller.signal.aborted) throw new Error('MP4 metadata budget exceeded.');
      const scoped = target.origin === initial.origin ? headers : Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization', 'proxy-authorization', 'host'].includes(key.toLowerCase())));
      response = await requestUpstream(target, {
        allowPrivate, signal: controller.signal, timeout, followRedirects: false,
        headers: { ...scoped, Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }
      });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) break;
      response.body.destroy();
      target = validUpstreamURL(new URL(response.headers.location, target).href, allowPrivate);
    }
    try {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
      const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
      if (response.status !== 206 || !match || encoding !== 'identity') throw new Error('MP4 byte ranges unavailable.');
      const [first, last, size] = match.slice(1).map(Number);
      if (![first, last, size].every(Number.isSafeInteger) || first !== start || last > end || last < first || size <= last || (total !== null && total !== size)) throw new Error('Invalid MP4 Content-Range.');
      const expected = last - first + 1;
      if (expected > MAX_BYTES - bytes || Number(response.headers['content-length'] || expected) > expected) throw new Error('MP4 metadata budget exceeded.');
      const buffer = await readBody(response, expected);
      if (buffer.length !== expected) throw new Error('Truncated MP4 range.');
      bytes += buffer.length;total = size;target = validUpstreamURL(response.url, allowPrivate);
      return { start, buffer };
    } finally { response.body.destroy(); }
  };
  const read = async (offset, length) => {
    if (block && offset >= block.start && offset + length <= block.start + block.buffer.length) return block.buffer.subarray(offset - block.start, offset - block.start + length);
    block = await range(offset, Math.max(length, 64));
    if (block.buffer.length < length) throw new Error('Truncated MP4 box.');
    return block.buffer.subarray(0, length);
  };
  const atom = async (offset, boundary) => {
    if (!Number.isSafeInteger(offset) || offset + 8 > boundary) throw new Error('Truncated MP4 box.');
    const first = await read(offset, 8), type = first.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error('Unsupported media format.');
    let size = first.readUInt32BE(0), header = 8;
    if (size === 1) {
      const extended = (await read(offset, 16)).readBigUInt64BE(8);
      if (extended > SAFE_BIGINT) throw new Error('Invalid extended MP4 size.');
      size = Number(extended);header = 16;
    } else if (size === 0) size = boundary - offset;
    if (size < header || !Number.isSafeInteger(offset + size) || offset + size > boundary) throw new Error('Invalid MP4 box size.');
    return { type, size, header, start: offset, end: offset + size };
  };
  try {
    block = await range(0, 64 * 1024);
    for (let offset = 0, count = 0; offset + 8 <= total && count < 2048; count++) {
      const box = await atom(offset, total);
      if (box.type === 'moov') {
        for (let child = box.start + box.header, children = 0; child + 8 <= box.end && children < 2048; children++) {
          const entry = await atom(child, box.end);
          if (entry.type === 'mvhd') {
            const available = entry.size - entry.header;
            if (available < 20) return null;
            return mvhdDuration(await read(entry.start + entry.header, Math.min(available, 32)));
          }
          child = entry.end;
        }
        return null;
      }
      offset = box.end;
    }
    return null;
  } catch { return null; }
  finally { clearTimeout(timer);signal?.removeEventListener('abort', abort); }
}
