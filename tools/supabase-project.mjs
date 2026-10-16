// Project-scoped administration over the official Supabase Management API.
// The expiring PAT stays in .local/, never in argv, source control or browser code.
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const projectRef = 'wnicimkmzswksaqdtgdv';
const api = `https://api.supabase.com/v1/projects/${projectRef}`;
const tokenPath = new URL('.local/supabase-access-token', root);
const [command = 'status', flag, filename] = process.argv.slice(2);
const timeoutMs = Number(process.env.ARKHEN_SUPABASE_ADMIN_TIMEOUT_MS || 120_000);

try {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error('Prazo administrativo inválido.');
  const metadata = await stat(tokenPath);
  if ((metadata.mode & 0o077) !== 0) throw new Error('Proteja .local/supabase-access-token com chmod 600.');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^sbp_[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Credencial de gerenciamento ausente ou inválida.');
  let path = api;
  let body;
  if (command === 'query' || command === 'migrate') {
    if (flag !== '--file' || !filename || !filename.endsWith('.sql')) throw new Error(`Uso: npm run supabase:project -- ${command} --file caminho.sql`);
    const query = await readFile(fileURLToPath(new URL(filename, root)), 'utf8');
    const name = filename.split('/').at(-1).replace(/^\d+_/, '').replace(/\.sql$/, '');
    body = JSON.stringify({ query, ...(command === 'migrate' ? { name } : {}) });
    path += command === 'migrate' ? '/database/migrations' : '/database/query';
  } else if (command !== 'status') {
    throw new Error('Comandos disponíveis: status; query --file caminho.sql; migrate --file caminho.sql');
  }
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok) {
    const detail = String(result.message || result.error || 'Falha de gerenciamento').replaceAll(token, '[oculto]');
    throw new Error(`Supabase HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (command === 'status') {
    if (result.id !== projectRef) throw new Error('O servidor respondeu com outro projeto.');
    console.log(JSON.stringify({ projectRef, name: result.name, status: result.status }, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
