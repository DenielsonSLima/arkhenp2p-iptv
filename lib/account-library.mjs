import { createHash } from 'node:crypto';

/** Stable local-library namespace, without returning a username or credentials. */
export function accountLibrarySession(session, config = {}, provider = 'xtream') {
  if (!session?.connected || !session.account || typeof config.username !== 'string' || !config.username.trim()) return session;
  let server;
  try {
    const url = new URL(config.server);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    server = url.href.replace(/\/+$/, '');
  } catch { return session; }
  const kind = ['wplay', 'wplay-ott', 'xtream'].includes(provider) ? provider : 'xtream';
  const input=config.username.trim(),username=kind==='wplay'&&!input.includes('@')?input+'@wareztv.io':input;
  const libraryId = createHash('sha256').update(JSON.stringify(['arkhen-library-v1', kind, server, username])).digest('hex');
  return {...session, account:{...session.account, provider:kind, libraryId}};
}
