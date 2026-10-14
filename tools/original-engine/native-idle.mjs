// Read-only state observation for the exact original WPlay 11.9.0d ARM64 build.
// No memory writes, replacements, authentication hooks or native calls.
const BUILD_ID = 'a96953714ac78cb1b426b35def41b801a56884e9';
const QUEUE_OFFSET = 0x135738;
const QUEUE_PROLOGUE = 'ff0303d1fd7b07a9fa6708a9f85f09a9';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function hex(pointer, size) {
  return Array.from(new Uint8Array(pointer.readByteArray(size)), value => value.toString(16).padStart(2, '0')).join('');
}

export function createNativeIdleObserver(handle, onIdle, onError, runtime = globalThis) {
  const { Process, Interceptor, ptr } = runtime;
  if (Process.arch !== 'arm64') fail('ENGINE_STATE_BUILD_UNSUPPORTED');
  const module = Process.getModuleByName('libtvcore.so');
  if (hex(module.base.add(0x318), 20) !== BUILD_ID
    || hex(module.base.add(QUEUE_OFFSET), 16) !== QUEUE_PROLOGUE) fail('ENGINE_STATE_BUILD_UNSUPPORTED');
  const context = ptr(handle).readPointer();
  if (context.isNull()) fail('ENGINE_STATE_UNAVAILABLE');
  let armed = null, counter = 0, state = null, failed = false;
  const observer = Interceptor.attach(module.base.add(QUEUE_OFFSET), {
    onEnter(args) {
      this.ticket = args[0].equals(context) ? armed : null;
    },
    onLeave() {
      if (!this.ticket || this.ticket !== armed || failed) return;
      try {
        counter++;
        state = context.add(0x14c).readU32();
        if (state > 3) fail('ENGINE_STATE_UNAVAILABLE');
        // Original state parser: 0 initing, 1 ready, 2 buffering, 3 failed.
        // The run loop only consumes this queue after the playback routine
        // returns. A queued next URL at +0x88 must also be absent.
        const next = context.add(0x88);
        const empty = next.readU8() & 1 ? next.add(8).readU64().toString() === '0' : next.readU8() === 0;
        if ((state === 1 || state === 3) && empty) {
          armed = null;
          onIdle({ state, consumed: true });
        }
      } catch {
        armed = null; failed = true;
        onError('ENGINE_STATE_UNAVAILABLE');
      }
    },
  });
  return {
    // Arm only AFTER stop() returns: a subsequent queue entry is then a fence
    // for that stop command. A queue cycle already in progress cannot satisfy it.
    arm() { if (failed) fail('ENGINE_STATE_UNAVAILABLE'); armed = {}; },
    cancel() { armed = null; },
    status() { return { buildVerified: true, state, consumedCycles: counter, available: !failed }; },
    close() { armed = null; observer.detach(); },
  };
}
