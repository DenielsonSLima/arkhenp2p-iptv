import { readFile } from 'node:fs/promises';
import { NativeBridgeManager } from './native-bridge-manager.mjs';
import { OriginalEngineBridge } from './original-engine-bridge.mjs';
import { ProviderError } from './provider.mjs';

const invalid = () => new ProviderError('A configuração local da engine original é inválida.', 'ORIGINAL_ENGINE_CONFIGURATION', 503);

export function originalEngineOptions(env = process.env) {
  const enabled = env.ARKHEN_ORIGINAL_ENGINE;
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') throw invalid();
  const endpoint = env.ARKHEN_ORIGINAL_ENGINE_ENDPOINT || '127.0.0.1:27043';
  const rawPort = env.ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT || '8904';
  if (!/^127\.0\.0\.1:\d{4,5}$/.test(endpoint) || !/^\d{4,5}$/.test(rawPort)) throw invalid();
  const port = Number(endpoint.split(':')[1]), mediaPort = Number(rawPort);
  if (port < 1024 || port > 65535 || mediaPort < 1024 || mediaPort > 65535 || port === mediaPort) throw invalid();
  return { endpoint, mediaPort };
}

// Selecting this backend does not connect to Frida or create a subprocess.
// The first authorized live playback attaches and verifies the original account.
export function configuredNativeBridge({ env = process.env,
  readKey = () => readFile(new URL('../.local/native-bridge-key', import.meta.url), 'utf8'),
} = {}) {
  const options = originalEngineOptions(env);
  if (options) return Promise.resolve(new NativeBridgeManager({ client: new OriginalEngineBridge({...options,env}) }));
  return readKey().then(key => new NativeBridgeManager({ key: key.trim() })).catch(() => null);
}
