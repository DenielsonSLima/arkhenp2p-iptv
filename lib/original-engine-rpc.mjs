import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './provider.mjs';
import {runtimePythonPath,absoluteRuntimePath,pythonProcessEnvironment} from '../tools/p2p-runtime-paths.mjs';

const fail = code => new ProviderError('Não foi possível comunicar com o aplicativo P2P original.', code, 503);
const SAFE = /^(?:AGENT|ENGINE|JAVA|LISTENER|METHOD|INVALID|LOCAL|NATIVE|EXTERNAL|REQUEST|STOP|PLAYBACK)_[A-Z_]+$/;

// Private pipes are the control boundary: no HTTP, shell, credential argv,
// inherited server environment, or diagnostic output from the child.
export class OriginalEngineRPC {
  #child; #pending = null; #ready; #queue = Promise.resolve(); #buffer = '';
  #closed = false; #closing = null; #exit; #startupTimer;
  #cleanupGraceMs;
  get closed() { return this.#closed; }
  constructor({ endpoint = '127.0.0.1:27043', spawnProcess = spawn, cleanupGraceMs = 6500,
    python,platform=process.platform,env=process.env,
    script = fileURLToPath(new URL('../tools/original-engine/client.py', import.meta.url)),
    agent = fileURLToPath(new URL('../tools/original-engine/agent.bundle.js', import.meta.url)),
  } = {}) {
    if (!/^127\.0\.0\.1:\d{4,5}$/.test(endpoint) || +endpoint.split(':')[1] < 1024 || +endpoint.split(':')[1] > 65535) throw fail('INVALID_LOCAL_ENDPOINT');
    try{python=python?absoluteRuntimePath(python,{platform}):runtimePythonPath(fileURLToPath(new URL('../',import.meta.url)),{platform,env});if(platform==='win32'&&!/\.exe$/i.test(python))throw new Error();}catch{throw fail('ENGINE_PYTHON_CONFIGURATION');}
    // The agent's owned stop fence can legitimately take up to five seconds.
    this.#cleanupGraceMs = Math.max(1, Math.min(10000, Number(cleanupGraceMs) || 6500));
    this.#child = spawnProcess(python, ['-I','-B','-X','utf8',script, '--endpoint', endpoint, '--agent', agent], {
      shell: false,windowsHide:true, stdio: ['pipe', 'pipe', 'ignore'],
      env:pythonProcessEnvironment({platform,env}),
    });
    this.#exit = new Promise(resolve => {
      this.#child.once('exit', resolve); this.#child.once('close', resolve); this.#child.once('error', resolve);
    });
    this.#ready = new Promise((resolve, reject) => {
      this.#pending = { op: 'attached', resolve, reject };
      this.#startupTimer = setTimeout(() => this.#failure('ENGINE_ATTACH_TIMEOUT'), 20000);
    });
    this.#ready.catch(() => {});
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    this.#child.stdin.on('error', () => this.#failure('ENGINE_CONTROL_CLOSED'));
    this.#child.on('error', () => this.#failure('ENGINE_PROCESS_FAILED'));
    this.#child.on('exit', () => this.#failure('ENGINE_PROCESS_CLOSED'));
  }
  #failure(code) {
    clearTimeout(this.#startupTimer);
    this.#pending?.reject(fail(code));
    this.#pending = null; this.#closed = true;
  }
  #receive(chunk) {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 65536) { this.#failure('ENGINE_PROTOCOL_INVALID'); void this.close(); return; }
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
      let value;
      try { value = JSON.parse(line); } catch { this.#failure('ENGINE_PROTOCOL_INVALID'); void this.close(); return; }
      const pending = this.#pending;
      if (!pending || !value || typeof value !== 'object'
        || (value.ok === true && (pending.op === 'attached' ? value.event !== 'attached' : value.op !== pending.op))) {
        this.#failure('ENGINE_PROTOCOL_INVALID'); void this.close(); return;
      }
      clearTimeout(this.#startupTimer); this.#pending = null;
      if (value.ok === true) pending.resolve(value.result);
      else pending.reject(fail(typeof value.error === 'string' && SAFE.test(value.error) ? value.error : 'ENGINE_RPC_FAILED'));
    }
  }
  async ready({ signal } = {}) {
    if (signal?.aborted) throw fail('PLAYBACK_CANCELLED');
    return this.#interruptible(this.#ready, signal);
  }
  #interruptible(result, signal) {
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const abort = () => reject(fail('PLAYBACK_CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  call(op, values = {}, { signal, timeout = 35000 } = {}) {
    const run = async () => {
      await this.#ready;
      if (this.#closed || signal?.aborted) throw fail(signal?.aborted ? 'PLAYBACK_CANCELLED' : 'ENGINE_CONTROL_CLOSED');
      return new Promise((resolve, reject) => {
        const finish = fn => value => { clearTimeout(timer); fn(value); };
        const timer = setTimeout(() => { this.#failure('ENGINE_RPC_TIMEOUT'); void this.close(); }, Math.max(1000, Math.min(70000, timeout)));
        this.#pending = { op, resolve: finish(resolve), reject: finish(reject) };
        const line = JSON.stringify({ ...values, op }) + '\n';
        if (Buffer.byteLength(line) > 65536) { this.#failure('INVALID_REQUEST_SIZE'); void this.close(); return; }
        this.#child.stdin.write(line);
      });
    };
    const result = this.#queue.catch(() => {}).then(run);
    // Cancellation releases the caller immediately but drains the protocol
    // response before its next command. Unloading this Java bridge on a routine
    // switch can crash Android ART. The adapter follows with an owned stop.
    this.#queue = result.catch(() => {});
    return this.#interruptible(result, signal);
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#failure('ENGINE_CONTROL_CLOSED');
    this.#closing = (async () => {
      // EOF lets an idle client stop its owned playback, restore observers and
      // detach without interrupting a Java/Frida call. SIGINT is a bounded
      // fallback for an outstanding RPC; it still runs Python's finally.
      this.#child.stdin.end();
      const interrupt = setTimeout(() => { if (this.#child.exitCode === null) this.#child.kill('SIGINT'); }, this.#cleanupGraceMs);
      const force = setTimeout(() => { if (this.#child.exitCode === null) this.#child.kill('SIGKILL'); }, this.#cleanupGraceMs + 8000);
      interrupt.unref?.();
      force.unref?.();
      await this.#exit; clearTimeout(interrupt); clearTimeout(force);
    })();
    return this.#closing;
  }
}
