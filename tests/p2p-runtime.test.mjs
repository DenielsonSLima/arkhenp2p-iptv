import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { acquireLauncherLock, assertDevice, requiredForwards, createRuntime } from '../tools/p2p-runtime.mjs';

test('checks exact AVD and target online status', () => {
  assert.equal(assertDevice('List of devices attached\n', ''), false);
  assert.equal(assertDevice('emulator-5582\tdevice\n', 'Arkhen_Engine_Debug\nOK'), true);
  assert.throws(() => assertDevice('emulator-5582\tdevice\n', 'Other'), { code: 'P2P_WRONG_AVD' });
  assert.throws(() => assertDevice('emulator-5582\toffline\n', 'Arkhen_Engine_Debug'), { code: 'P2P_DEVICE_OFFLINE' });
});

test('reuses matching forwards and refuses any conflicting ownership or port', () => {
  assert.deepEqual(requiredForwards(''), [[27043, 27042], [8904, 8902]]);
  assert.deepEqual(requiredForwards('emulator-5582 tcp:27043 tcp:27042\nemulator-5582 tcp:8904 tcp:8902'), []);
  assert.throws(() => requiredForwards('emulator-5580 tcp:8904 tcp:8902'), { code: 'P2P_FORWARD_CONFLICT' });
  assert.throws(() => requiredForwards('emulator-5582 tcp:8904 tcp:8080'), { code: 'P2P_FORWARD_CONFLICT' });
});

test('launcher lock rejects live and incomplete locks, recovers dead owner only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'arkhen-p2p-lock-'));
  const file = path.join(dir, 'lock');
  try {
    const release = await acquireLauncherLock(file, { pid: 123, alive: () => true });
    await assert.rejects(acquireLauncherLock(file, { pid: 456, alive: () => true }), { code: 'P2P_ALREADY_RUNNING' });
    await release();
    await writeFile(file, '');
    await assert.rejects(acquireLauncherLock(file, { pid: 456, alive: () => false }), { code: 'P2P_ALREADY_RUNNING' });
    await writeFile(file, '123');
    const releaseRecovered = await acquireLauncherLock(file, { pid: 456, alive: () => false });
    assert.equal(await readFile(file, 'utf8'), '456');
    await releaseRecovered();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function harness({ running = true, authenticated = true, ready = true, avd = 'Arkhen_Engine_Debug',
  forwards = 'emulator-5582 tcp:27043 tcp:27042\nemulator-5582 tcp:8904 tcp:8902', otherAVD = false } = {}) {
  const calls = [], launches = [];
  let booted = running;
  const run = async (file, args) => {
    calls.push({ file, args });
    let output;
    const command = args.join(' ');
    if (file.endsWith('python3')) output = args.includes('-c') ? '17.8.0' : JSON.stringify({ authenticated, ready });
    else if (command.endsWith('start-server')) output = '';
    else if (command.endsWith('devices')) output = booted ? 'emulator-5582\tdevice\n' : (otherAVD ? 'emulator-5554\tdevice\n' : '');
    else if (command.endsWith('emu avd name')) output = avd + '\nOK';
    else if (command.endsWith('sys.boot_completed')) output = '1';
    else if (command.includes('pm path')) output = 'package:/data/app/original/base.apk';
    else if (command.endsWith('id -u')) output = '0';
    else if (command.endsWith('--version')) output = '17.8.0';
    else if (command.includes('pidof')) output = '1234';
    else if (command.endsWith('forward --list')) output = forwards;
    else if (command.includes('forward --no-rebind')) output = '';
    else throw new Error('Unexpected command: ' + command);
    return { stdout: output };
  };
  const launch = (file, args, options) => {
    launches.push({ file, args, options });
    booted = true;
    const child = new EventEmitter(); child.unref = () => {};
    return child;
  };
  const runtime = createRuntime('/project', { run, launch, portOpen: async () => false,
    exists: async () => {}, sleep: async () => {} });
  return { runtime, calls, launches };
}

test('already prepared runtime is reused without start, root, install or rebinding', async () => {
  const { runtime, calls, launches } = harness();
  assert.deepEqual(await runtime.prepare(), { ready: true });
  assert.equal(launches.length, 0);
  const commands = calls.map(call => call.args.join(' ')).join('\n');
  assert.doesNotMatch(commands, /(?:force-stop|install|kill-server| shell am start| -s emulator-5582 root|--no-rebind)/);
  assert.match(commands, /readiness.py --endpoint 127.0.0.1:27043/);
  for (const { file, args } of calls.filter(call => call.file.endsWith('/adb'))) {
    assert.deepEqual(args.slice(0, 4), ['-H', '127.0.0.1', '-P', '5038'], file);
  }
});

test('missing runtime starts only project AVD with isolated data and exact port', async () => {
  const { runtime, launches } = harness({ running: false });
  await runtime.prepare();
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.deepEqual(launch.args.slice(0, 4), ['-avd', 'Arkhen_Engine_Debug', '-port', '5582']);
  assert.equal(launch.options.env.ANDROID_AVD_HOME, '/project/native-bridge/debug-runtime/avd');
  assert.equal(launch.options.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:5038');
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.stdio, 'ignore');
});

test('existing project AVD on another port is preserved without launching duplicate', async () => {
  const { runtime, launches } = harness({ running: false, otherAVD: true });
  await assert.rejects(runtime.prepare(), { code: 'P2P_AVD_OTHER_PORT' });
  assert.equal(launches.length, 0);
});

test('missing login is explicit and never submits account credentials', async () => {
  const { runtime, calls } = harness({ authenticated: false, ready: false });
  await assert.rejects(runtime.prepare(), { code: 'P2P_LOGIN_REQUIRED' });
  assert.doesNotMatch(JSON.stringify(calls), /(?:password|username|login-agent|login.py|input text)/i);
});

test('authenticated but uninitialized engine prevents web startup', async () => {
  const { runtime } = harness({ authenticated: true, ready: false });
  await assert.rejects(runtime.prepare(), { code: 'P2P_ENGINE_NOT_READY' });
});

test('new forwards use no-rebind and explicit device only', async () => {
  const { runtime, calls } = harness({ forwards: '' });
  await runtime.prepare();
  const forwards = calls.filter(call => call.args.includes('--no-rebind'));
  assert.equal(forwards.length, 2);
  forwards.forEach(call => assert.deepEqual(call.args.slice(4, 6), ['-s', 'emulator-5582']));
});
