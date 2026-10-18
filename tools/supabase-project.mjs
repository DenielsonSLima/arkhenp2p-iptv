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
  if (command === 'query' || command === 'migrate' || command === 'inspect') {
    if (flag !== '--file' || !filename || !filename.endsWith('.sql')) throw new Error(`Uso: npm run supabase:project -- ${command} --file caminho.sql`);
    const query = await readFile(fileURLToPath(new URL(filename, root)), 'utf8');
    const name = filename.split('/').at(-1).replace(/^\d+_/, '').replace(/\.sql$/, '');
    body = JSON.stringify({ query, ...(command === 'migrate' ? { name } : command === 'query' ? { read_only: false } : {}) });
    path += command === 'migrate' ? '/database/migrations' : command === 'inspect' ? '/database/query/read-only' : '/database/query';
  } else if(command==='health') {
    path+='/health?services=db,auth,rest';
  } else if(command==='metrics') {
    path+='/analytics/endpoints/metrics';
  } else if(command==='restart') {
    path+='/restart';
  } else if (command !== 'status') {
    throw new Error('Comandos disponíveis: status; health; metrics; restart; inspect --file caminho.sql; query --file caminho.sql; migrate --file caminho.sql');
  }
  const response = await fetch(path, {
    method: body || command==='restart' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if(command==='restart'&&response.ok) {
    // HTTP acceptance is not proof of recovery; read health/start time later.
    console.log(JSON.stringify({projectRef,restartRequested:true,httpStatus:response.status},null,2));
    process.exit(0);
  }
  if(command==='metrics') {
    if(!response.ok)throw new Error(`Supabase metrics HTTP ${response.status}`);
    // Export only resource counters, never SQL, arbitrary labels or credentials.
    const allowed=/^(node_cpu_seconds_total|node_load[0-9]+|node_memory_(MemTotal|MemAvailable|SwapTotal|SwapFree)_bytes|node_disk_(read_bytes|written_bytes|reads_completed|writes_completed|io_time_seconds|io_time_weighted_seconds|read_time_seconds|write_time_seconds)_total|node_vmstat_(pswpin|pswpout)|pg_exporter_last_scrape_error)$/;
    const samples=[];
    for(const line of (await response.text()).split('\n')) {
      const match=line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+\d+)?$/);
      if(!match||!allowed.test(match[1]))continue;
      const labels={};
      for(const label of (match[2]||'').matchAll(/(?:^|,)\s*(cpu|mode|device)="([a-zA-Z0-9_.-]{1,40})"/g))labels[label[1]]=label[2];
      const value=Number(match[3]);
      if(Number.isFinite(value))samples.push({metric:match[1],labels,value});
    }
    if(!samples.length)throw new Error('Nenhum contador de recurso reconhecido; não interpretar como CPU zero.');
    console.log(JSON.stringify({projectRef,observedAt:new Date().toISOString(),samples},null,2));
    process.exit(0);
  }
  const result = await response.json();
  if (!response.ok) {
    const detail = String(result.message || result.error || 'Falha de gerenciamento').replaceAll(token, '[oculto]');
    throw new Error(`Supabase HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (command === 'status') {
    if (result.id !== projectRef) throw new Error('O servidor respondeu com outro projeto.');
    console.log(JSON.stringify({ projectRef, name: result.name, status: result.status }, null, 2));
  } else if(command==='health') {
    if(!Array.isArray(result))throw new Error('Resposta de saúde inválida.');
    console.log(JSON.stringify(result.map(row=>({name:['db','auth','rest'].includes(row.name)?row.name:'unknown',healthy:row.healthy===true,
      status:typeof row.status==='string'&&/^[A-Z_]{1,50}$/.test(row.status)?row.status:'UNKNOWN'})),null,2));
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
