import { createInterface } from 'node:readline';

export async function readWplayCredentials() {
  console.log('Aguardando JSON de acesso via stdin (sem eco/persistência).');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const reader = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 8192) throw new Error('INPUT_INVALID');
      let value;try { value = JSON.parse(line); } catch { throw new Error('INPUT_INVALID'); }
      if (typeof value.username !== 'string' || typeof value.password !== 'string' || !value.username.trim() || !value.password || value.username.length > 200 || value.password.length > 200) throw new Error('INPUT_INVALID');
      return { username: value.username, password: value.password };
    }
    throw new Error('INPUT_REQUIRED');
  } finally {
    reader.close();process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
}

export function safeCode(error) {
  const code = String(error?.code || error?.name || 'REQUEST_FAILED');
  return /^[A-Z_a-z0-9]{1,40}$/.test(code) ? code : 'REQUEST_FAILED';
}

export function sanitizeWplayMessage(value, secrets = []) {
  let message = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (typeof secret === 'string' && secret) message = message.split(secret).join('••••');
  return message
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [TOKEN]')
    .replace(/\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+\b/gi, '[TOKEN]')
    .slice(0, 240);
}
