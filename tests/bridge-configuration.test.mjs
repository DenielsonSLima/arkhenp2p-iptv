import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredNativeBridge, originalEngineOptions } from '../lib/bridge-configuration.mjs';
import { NativeBridgeManager } from '../lib/native-bridge-manager.mjs';
import { createApp } from '../lib/app-server.mjs';

test('original engine is disabled by default and has explicit local defaults', async () => {
  assert.equal(originalEngineOptions({}), null);
  assert.equal(originalEngineOptions({ ARKHEN_ORIGINAL_ENGINE: '0' }), null);
  assert.deepEqual(originalEngineOptions({ ARKHEN_ORIGINAL_ENGINE: '1' }), { endpoint: '127.0.0.1:27043', mediaPort: 8904 });
  assert.equal(await configuredNativeBridge({ env: {}, readKey: async () => { throw new Error('not configured'); } }), null);
});

test('explicit original mode takes priority over the legacy bridge without reading its key', async () => {
  const bridge = await configuredNativeBridge({ env: { ARKHEN_ORIGINAL_ENGINE: '1' },
    readKey: async () => { assert.fail('legacy credentials must not be read'); } });
  assert.ok(bridge instanceof NativeBridgeManager);
});

test('invalid original configuration fails before any attach or legacy fallback', () => {
  for (const env of [
    { ARKHEN_ORIGINAL_ENGINE: 'true' },
    { ARKHEN_ORIGINAL_ENGINE: '1', ARKHEN_ORIGINAL_ENGINE_ENDPOINT: 'remote.example:27043' },
    { ARKHEN_ORIGINAL_ENGINE: '1', ARKHEN_ORIGINAL_ENGINE_ENDPOINT: '127.0.0.1:99999' },
    { ARKHEN_ORIGINAL_ENGINE: '1', ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT: '80' },
    { ARKHEN_ORIGINAL_ENGINE: '1', ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT: '27043' },
    { ARKHEN_ORIGINAL_ENGINE: '1', ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT: '8904?token=private' },
  ]) {
    assert.throws(() => configuredNativeBridge({ env, readKey: async () => assert.fail('must not fall back') }),
      error => error.code === 'ORIGINAL_ENGINE_CONFIGURATION' && !error.message.includes('private'));
  }
});

test('explicit dependency injection bypasses environment selection', async () => {
  const server = createApp({ connection: {}, nativeBridge: null, environment: { ARKHEN_ORIGINAL_ENGINE: 'invalid' } });
  await server.shutdown();
});
