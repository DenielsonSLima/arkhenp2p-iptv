import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {homedir} from 'node:os';
import {resolveRuntimePaths,runtimeProcessEnvironment} from './p2p-runtime-paths.mjs';

const exec = promisify(execFile);
export const AVD = 'Arkhen_Engine_Debug';
export const SERIAL = 'emulator-5582';
export const PACKAGE = 'io.wareztv.android.one';
const FORWARDS = [[27043, 27042], [8904, 8902]];
export function runtimeError(code) { return Object.assign(new Error(code), { code }); }

export function assertDevice(devices, avdName) {
  const entry = String(devices).split('\n').find(line => line.startsWith(SERIAL + '\t'));
  if (!entry) return false;
  if (!/^emulator-5582\tdevice(?:\s|$)/.test(entry)) throw runtimeError('P2P_DEVICE_OFFLINE');
  if (String(avdName).split(/\r?\n/)[0].trim() !== AVD) throw runtimeError('P2P_WRONG_AVD');
  return true;
}

export function requiredForwards(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/));
  return FORWARDS.filter(([local, remote]) => {
    const existing = lines.filter(([, endpoint]) => endpoint === `tcp:${local}`);
    if (existing.length > 1 || existing.some(([serial, , target]) => serial !== SERIAL || target !== `tcp:${remote}`)) {
      throw runtimeError('P2P_FORWARD_CONFLICT');
    }
    return existing.length === 0;
  });
}

export function localPortOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function acquireLauncherLock(file, { pid = process.pid, alive = id => {
  try { process.kill(id, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(pid));
      await handle.close();
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === String(pid)) await unlink(file).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw runtimeError('P2P_LOCK_UNAVAILABLE');
      const previous = Number(await readFile(file, 'utf8').catch(() => ''));
      // An empty lock can be a concurrent writer. Never remove it speculatively.
      if (!Number.isSafeInteger(previous) || previous < 1 || alive(previous)) throw runtimeError('P2P_ALREADY_RUNNING');
      await unlink(file).catch(() => {});
    }
  }
  throw runtimeError('P2P_ALREADY_RUNNING');
}

export function createRuntime(root, { run = exec, launch = spawn, portOpen = localPortOpen,
  exists = access, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, notify = () => {}, signal,platform=process.platform,env=process.env,home=homedir() } = {}) {
  const runtime = path.join(root, 'native-bridge/debug-runtime');
  let adb,emulator,python,componentEnvironment;
  const prefix = ['-H', '127.0.0.1', '-P', '5038'];
  function cancelled() { if (signal?.aborted) throw runtimeError('P2P_CANCELLED'); }
  async function command(file, args, { timeout = 15000, ...options } = {}) {
    cancelled();
    try { return (await run(file, args, { timeout, maxBuffer: 1024 * 1024, signal, ...options,shell:false,windowsHide:true,env:componentEnvironment })).stdout.trim(); }
    catch { cancelled(); throw runtimeError('P2P_COMPONENT_COMMAND_FAILED'); }
  }
  const host = (...args) => command(adb, [...prefix, ...args]);
  const device = (...args) => command(adb, [...prefix, '-s', SERIAL, ...args]);
  async function waitFor(check, timeout, code) {
    const deadline = now() + timeout;
    do {
      cancelled();
      if (await check()) return;
      await sleep(750);
    } while (now() < deadline);
    throw runtimeError(code);
  }
  async function prepare() {
    const resolved=await resolveRuntimePaths(root,{platform,env,home,exists});
    ({adb,emulator,python}=resolved);componentEnvironment=runtimeProcessEnvironment(resolved,{env});
    for (const file of [adb, emulator, python, path.join(runtime, 'avd', AVD + '.ini'),
      path.join(root, 'tools/original-engine/readiness-agent.bundle.js'),
      path.join(root, 'tools/original-engine/agent.bundle.js')]) {
      try { await exists(file); } catch { throw runtimeError('P2P_COMPONENT_MISSING'); }
    }
    const fridaVersion = await command(python, ['-I','-B','-X','utf8', '-c', 'import frida; print(frida.__version__)']);
    if (fridaVersion !== '17.8.0') throw runtimeError('P2P_FRIDA_VERSION');
    await host('start-server');
    let devices = await host('devices');
    if (!devices.split('\n').some(line => line.startsWith(SERIAL + '\t'))) {
      // Never launch a second instance of this AVD on another existing emulator.
      for (const line of devices.split('\n')) {
        const serial = /^(emulator-[0-9]+)\tdevice(?:\s|$)/.exec(line)?.[1];
        if (serial) {
          const name = await command(adb, [...prefix, '-s', serial, 'emu', 'avd', 'name']);
          if (name.split(/\r?\n/)[0].trim() === AVD) throw runtimeError('P2P_AVD_OTHER_PORT');
        }
      }
      if (await portOpen(5582) || await portOpen(5583)) throw runtimeError('P2P_EMULATOR_PORT_BUSY');
      notify('Iniciando o emulador local de TV…');
      const child = launch(emulator, ['-avd', AVD, '-port', '5582', '-gpu', 'swiftshader',
        '-no-audio', '-no-snapshot', '-no-boot-anim', '-no-window'], {
        cwd: root, detached: true, stdio: 'ignore',shell:false,windowsHide:true,env:componentEnvironment,
      });
      let failed = false;
      child.once('error', () => { failed = true; });
      child.unref();
      await waitFor(async () => {
        if (failed) throw runtimeError('P2P_EMULATOR_START_FAILED');
        devices = await host('devices');
        return /^emulator-5582\tdevice(?:\s|$)/m.test(devices);
      }, 120000, 'P2P_EMULATOR_BOOT_TIMEOUT');
    }
    assertDevice(devices, await device('emu', 'avd', 'name'));
    await waitFor(async () => (await device('shell', 'getprop', 'sys.boot_completed')) === '1',
      120000, 'P2P_EMULATOR_BOOT_TIMEOUT');
    // The unmodified APK and the exact native observer use ARM64. An x86_64
    // host/image is acceptable only when Android itself advertises ARM64
    // translation; the host CPU alone does not establish compatibility.
    const abiList=(await device('shell','getprop','ro.product.cpu.abilist')).split(',').map(value=>value.trim());
    if(!abiList.includes('arm64-v8a'))throw runtimeError('P2P_ARM64_REQUIRED');
    const installed = await device('shell', 'pm', 'path', PACKAGE);
    if (!installed.startsWith('package:')) throw runtimeError('P2P_APK_MISSING');
    // The prepared debug AVD is the only device whose adbd can be restarted.
    if ((await device('shell', 'id', '-u')) !== '0') {
      await device('root');
      await device('wait-for-device');
      if ((await device('shell', 'id', '-u')) !== '0') throw runtimeError('P2P_DEBUG_ROOT_REQUIRED');
    }
    let serverVersion;
    try { serverVersion = await device('shell', '/data/local/tmp/arkhen-frida-server', '--version'); }
    catch { throw runtimeError('P2P_FRIDA_MISSING'); }
    if (serverVersion !== '17.8.0') throw runtimeError('P2P_FRIDA_VERSION');
    const getPid = async name => {
      try { return await device('shell', 'pidof', name); } catch { return ''; }
    };
    if (!(await getPid('arkhen-frida-server'))) {
      notify('Preparando a conexão local com o aplicativo…');
      await device('shell', '/data/local/tmp/arkhen-frida-server -l 127.0.0.1:27042 >/dev/null 2>&1 </dev/null &');
      await waitFor(async () => /^\d+(?: \d+)*$/.test(await getPid('arkhen-frida-server')),
        10000, 'P2P_FRIDA_START_FAILED');
    }
    for (const [local, remote] of requiredForwards(await host('forward', '--list'))) {
      if (await portOpen(local)) throw runtimeError('P2P_FORWARD_PORT_BUSY');
      await device('forward', '--no-rebind', `tcp:${local}`, `tcp:${remote}`);
    }
    if (!(await getPid(PACKAGE))) {
      notify('Abrindo o WPLAY original…');
      await device('shell', 'am', 'start', '-n', `${PACKAGE}/org.bitspark.android.Spark`);
    }
    notify('Verificando a sessão já salva no aplicativo…');
    const output = await command(python, ['-I','-B','-X','utf8', path.join(root, 'tools/original-engine/readiness.py'),
      '--endpoint', '127.0.0.1:27043'], { timeout: 65000 });
    let result;
    try { result = JSON.parse(output); } catch { throw runtimeError('P2P_READINESS_FAILED'); }
    if (['P2P_APK_VERSION', 'P2P_READINESS_FAILED'].includes(result.error)) throw runtimeError(result.error);
    if (result.authenticated !== true) throw runtimeError('P2P_LOGIN_REQUIRED');
    if (result.ready !== true) throw runtimeError('P2P_ENGINE_NOT_READY');
    return { ready: true };
  }
  return { prepare };
}
