export function mediaURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function parsePlaylist(text) {
  if (/#EXT-X-/i.test(text)) throw new Error('Este arquivo é um stream HLS. Use “Abrir URL” para reproduzir seu endereço .m3u8.');
  const result = [];
  let meta = {};
  let skipped = 0;
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attrs = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1],m[2]]));
      let quoted = false, comma = -1;
      for (let i=0; i<line.length; i++) { if (line[i] === '"') quoted = !quoted; if (line[i] === ',' && !quoted) { comma = i; break; } }
      meta = { title: comma >= 0 ? line.slice(comma+1).trim() : '', group:attrs['group-title'] || 'Importados' };
    } else if (line.startsWith('#EXTGRP:')) meta.group = line.slice(8).trim();
    else if (!line.startsWith('#')) {
      const url = mediaURL(line);
      if (url) result.push({id:`import-${result.length}`, title:meta.title || `Canal ${result.length+1}`, group:meta.group || 'Importados', kind:'imported', url, description:'Mídia da sua lista M3U.', art:'signal'});
      else skipped++;
      meta = {};
    }
  }
  if (!result.length) throw new Error('Nenhuma URL HTTP/HTTPS válida encontrada na lista.');
  return { items:result, skipped };
}
