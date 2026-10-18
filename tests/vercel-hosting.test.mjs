import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../lib/app-server.mjs';
import { createRequestHostPolicy } from '../lib/request-host-policy.mjs';

const execFileAsync = promisify(execFile);
const deployment = 'arkhen-fixture-project.vercel.app';
const branch = 'arkhen-git-main-fixture.vercel.app';
const production = 'arkhen-fixture.vercel.app';

async function fixture(t, environment = {}) {
  const app = createApp({
    connection: { server: 'https://fixture.invalid' },
    cloud: null,
    environment,
  });
  t.after(() => app.shutdown());
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  return (requestPath = '/', headers = {}) => new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1', port: app.address().port, path: requestPath, headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('Local hosting fixture timed out')));
  });
}

test('unconfigured local hosting serves the login document but rejects foreign authorities and forwarded spoofing', async t => {
  const request = await fixture(t);
  const local = await request();
  assert.equal(local.status, 200);
  assert.match(local.headers['content-type'], /^text\/html/);
  assert.match(local.body, /id="login-form"/);
  assert.equal((await request('/', { Host: 'localhost:4173' })).status, 200);
  assert.equal((await request('/', {
    Host: deployment, 'X-Forwarded-Host': 'localhost:4173',
  })).status, 403);
});

test('Vercel deployment, branch and production aliases serve the same document and its assets', async t => {
  const request = await fixture(t, {
    VERCEL: '1', VERCEL_URL: deployment, VERCEL_BRANCH_URL: branch,
    VERCEL_PROJECT_PRODUCTION_URL: production,
  });
  for (const Host of [deployment, branch, production]) {
    const document = await request('/', { Host });
    assert.equal(document.status, 200, Host);
    assert.match(document.body, /id="login-form"/);
    assert.equal((await request('/login-screen.css', { Host })).status, 200, Host);
  }
  for (const Host of ['unrelated.vercel.app', `${production}.attacker.invalid`, 'attacker.invalid']) {
    assert.equal((await request('/', { Host, 'X-Forwarded-Host': production })).status, 403, Host);
  }
});

test('public hosting retains the API same-origin guard', async t => {
  const request = await fixture(t, { ARKHEN_PUBLIC_ORIGIN: 'https://tv.example.invalid' });
  const Host = 'tv.example.invalid';
  const session = await request('/api/session', { Host, Origin: `https://${Host}` });
  assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).connected, false);
  assert.equal((await request('/api/session', { Host, Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/api/session', { Host, Origin: `https://${Host}`, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('host configuration grants only exact valid authorities and requires the Vercel runtime flag', () => {
  assert.equal(createRequestHostPolicy({ VERCEL_URL: deployment })(deployment), false);
  assert.equal(createRequestHostPolicy({ VERCEL: '0', VERCEL_URL: deployment })(deployment), false);
  assert.equal(createRequestHostPolicy({ VERCEL: '1', VERCEL_URL: deployment })(deployment.toUpperCase()), true);
  assert.equal(createRequestHostPolicy({ ARKHEN_PUBLIC_ORIGIN: 'https://tv.example.invalid:8443/' })('tv.example.invalid:8443'), true);
  assert.equal(createRequestHostPolicy({ ARKHEN_PUBLIC_ORIGIN: 'https://tv.example.invalid:8443/' })('tv.example.invalid'), false);
  for (const invalid of [
    'https://tv.example.invalid/path', 'http://tv.example.invalid',
    'https://*.example.invalid', 'https://user@tv.example.invalid',
    'https://tv.example.invalid?query=true', 'https://tv.example.invalid#fragment',
  ]) {
    assert.equal(createRequestHostPolicy({ ARKHEN_PUBLIC_ORIGIN: invalid })('tv.example.invalid'), false, invalid);
  }
  for (const invalid of ['*.vercel.app', `${deployment}/path`, `user@${deployment}`, `${deployment} `, `https://${deployment}`]) {
    assert.equal(createRequestHostPolicy({ VERCEL: '1', VERCEL_URL: invalid })(deployment), false, invalid);
  }
});

async function entrypointFixture(t) {
  // Run the real entrypoint/configuration contract with an inert HTTP factory.
  // All credentials below belong only to this temporary synthetic fixture.
  const directory = await mkdtemp(path.join(tmpdir(), 'arkhen-entrypoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'lib'));
  await copyFile(new URL('../server.mjs', import.meta.url), path.join(directory, 'server.mjs'));
  await Promise.all([
    copyFile(new URL('../lib/runtime-cloud-config.mjs', import.meta.url), path.join(directory, 'lib/runtime-cloud-config.mjs')),
    copyFile(new URL('../lib/supabase-cloud.mjs', import.meta.url), path.join(directory, 'lib/supabase-cloud.mjs')),
    writeFile(path.join(directory, 'lib/app-server.mjs'), `
      import http from 'node:http';
      export const createApp = options => {
        const server = http.createServer((_req, res) => res.end('fixture'));
        server.fixtureCloud = options.cloud;
        server.fixtureConnection = options.connection;
        server.shutdown = async () => {};
        server.listen = () => { throw new Error('Import must not open a listener'); };
        return server;
      };
      export const parseRange = () => null;
    `),
  ]);
  return directory;
}

const cloudFixture = {
  url: 'https://wnicimkmzswksaqdtgdv.supabase.co',
  publishableKey: 'sb_publishable_entrypoint_fixture_1234567890',
  gateway: { secret: 'entrypoint_fixture_gateway_secret_1234567890' },
};
const importAssertions = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    fs.readFile = () => { throw new Error('Import must not read private local files'); };
    syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('Import must not contact services'); };
    const { default: entrypoint, server } = await import('./server.mjs');
    assert.equal(entrypoint, server);
    assert.ok(entrypoint instanceof http.Server);
    assert.equal(entrypoint.listening, false);
`;

test('ordinary imported entrypoint ignores inherited cloud configuration without opening a port or reading private files', async t => {
  const directory = await entrypointFixture(t);
  for (const VERCEL of [undefined, '0']) {
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', importAssertions + `
      assert.equal(server.fixtureCloud, null);
      assert.deepEqual(server.fixtureConnection, {});
    `], { cwd: directory, env: {
      ...(VERCEL === undefined ? {} : { VERCEL }),
      ARKHEN_SUPABASE_CONFIG: JSON.stringify(cloudFixture),
      IPTV_SERVER: 'https://fixture.invalid', IPTV_USERNAME: 'fixture', IPTV_PASSWORD: 'fixture-password',
    }, timeout: 5000 });
    assert.equal(result.stderr, '');
  }
});

test('imported Vercel entrypoint initializes validated environment-only cloud configuration without network or local reads', async t => {
  const directory = await entrypointFixture(t);
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', importAssertions + `
    assert.equal(await server.fixtureCloud.ready, true);
    assert.equal(server.fixtureCloud.enabled, true);
    assert.equal(server.fixtureCloud.providerAuthenticationEnabled, true);
    assert.deepEqual(server.fixtureCloud.publicConfig(), ${JSON.stringify({ url: cloudFixture.url, publishableKey: cloudFixture.publishableKey })});
    assert.deepEqual(server.fixtureConnection, {});
    assert.equal(await server.fixtureCloud.refreshConfiguration({ force: true }), true);
  `], { cwd: directory, env: { VERCEL: '1', ARKHEN_SUPABASE_CONFIG: JSON.stringify(cloudFixture) }, timeout: 5000 });
  assert.equal(result.stderr, '');
});

test('Vercel preserves complete provider environment configuration without reading a private connection file', async t => {
  const directory = await entrypointFixture(t);
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', importAssertions + `
    assert.equal(server.fixtureCloud, null);
    assert.deepEqual(server.fixtureConnection, { server: 'https://fixture.invalid', username: 'fixture', password: 'fixture-password' });
  `], { cwd: directory, env: {
    VERCEL: '1', IPTV_SERVER: 'https://fixture.invalid', IPTV_USERNAME: 'fixture', IPTV_PASSWORD: 'fixture-password',
  }, timeout: 5000 });
});

test('missing or invalid Vercel cloud configuration leaves a usable unconfigured server with sanitized diagnostics', async t => {
  const directory = await entrypointFixture(t);
  const cases = [
    { name: 'absent' },
    { name: 'empty', value: '' },
    { name: 'explicitly disabled', value: JSON.stringify({ ...cloudFixture, enabled: false }) },
    { name: 'disabled without keys', value: '{"enabled":false}' },
    { name: 'malformed', value: '{"secret":"must-not-appear-in-diagnostics"', code: 'CLOUD_CONFIG_INVALID' },
    { name: 'wrong project', value: JSON.stringify({ ...cloudFixture, url: 'https://wrong-project.supabase.co' }), code: 'CLOUD_PROJECT_MISMATCH' },
    { name: 'invalid key', value: JSON.stringify({ ...cloudFixture, publishableKey: 'must-not-appear-in-diagnostics' }), code: 'CLOUD_CONFIG_INVALID' },
    { name: 'oversized', value: JSON.stringify({ ...cloudFixture, padding: 'ç'.repeat(16400) }), code: 'CLOUD_CONFIG_INVALID' },
    { name: 'null JSON', value: 'null', code: 'CLOUD_CONFIG_INVALID' },
  ];
  for (const entry of cases) {
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', importAssertions + `
      assert.equal(server.fixtureCloud, null);
      assert.deepEqual(server.fixtureConnection, {});
    `], { cwd: directory, env: { VERCEL: '1', ...(entry.value === undefined ? {} : { ARKHEN_SUPABASE_CONFIG: entry.value }) }, timeout: 5000 });
    assert.equal(result.stderr, entry.code ? `[cloud-configuration] {"code":"${entry.code}"}\n` : '', entry.name);
    assert.doesNotMatch(result.stderr + result.stdout, /must-not-appear|sb_publishable|gateway_secret|wrong-project|supabase\.co/);
  }
});

test('direct local cloud startup retains its existing private-file contract with synthetic configuration only', async t => {
  const directory = await entrypointFixture(t);
  await mkdir(path.join(directory, '.local'));
  await writeFile(path.join(directory, '.local/supabase.json'), JSON.stringify(cloudFixture));
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('Configuration must not contact services'); };
    const { createRuntimeCloud } = await import('./lib/runtime-cloud-config.mjs');
    const cloud = createRuntimeCloud({ executable: true, environment: {} });
    assert.equal(await cloud.ready, true);
    assert.equal(cloud.enabled, true);
    assert.equal(cloud.providerAuthenticationEnabled, true);
  `], { cwd: directory, env: {}, timeout: 5000 });
  assert.equal(result.stderr, '');
});
