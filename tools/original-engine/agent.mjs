import Java from 'frida-java-bridge';
import { createOriginalEngine } from './engine.mjs';
import { createNativeIdleObserver } from './native-idle.mjs';

// This is an attached debug agent, not an APK replacement or authentication hook.
rpc.exports = createOriginalEngine(Java, { idleObserverFactory: createNativeIdleObserver });
