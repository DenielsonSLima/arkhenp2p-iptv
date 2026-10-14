// WPLAYP2P 11.9.0d only. Replays the original login submit contract; it does
// not construct an auth response or change authentication/certificate checks.
const PACKAGE = 'io.wareztv.android.one';
function fail(code) { const error = new Error(code); error.code = code; return error; }
function step(code, action) {
  try { return action(); }
  catch { throw fail(code); }
}
// Frida prefixes a field with '_' when an obfuscated method shares its name
// (td.m.d(String) versus static AuthInfo d, Spark.U() versus be.e U).
export function javaField(owner, name) {
  const slot = owner[`_${name}`] ?? owner[name];
  if (!slot || !('value' in slot)) throw fail('LOGIN_FIELD_UNAVAILABLE');
  return slot.value;
}

export function normalizedCredentials(input, suffix) {
  if (typeof input?.username !== 'string' || typeof input?.password !== 'string'
      || input.username.length > 320 || input.password.length > 1024) throw fail('LOGIN_INVALID_INPUT');
  let username = input.username.trim();
  const password = input.password.trim();
  if (!username || !password || /[\x00-\x1f]/.test(username + password)) throw fail('LOGIN_INVALID_INPUT');
  if (!username.includes('@')) {
    if (suffix !== '@wareztv.io') throw fail('LOGIN_UNEXPECTED_SUFFIX');
    username += suffix;
  }
  return { username, password };
}

export function createOriginalLogin(Java) {
  let attached = false, closed = false, Spark, User, Preferences, Keys, Configuration;
  let callback, previous, operation = null, result = null, used = false;

  function javaTask(task, mainThread = false) {
    return new Promise((resolve, reject) => {
      if (!Java.available) return reject(fail('LOGIN_JAVA_UNAVAILABLE'));
      Java.perform(() => {
        const run = () => {
          try { resolve(task()); }
          catch (error) { reject(fail(/^LOGIN_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'LOGIN_JAVA_CALL_FAILED')); }
        };
        if (mainThread) Java.scheduleOnMainThread(run); else run();
      });
    });
  }

  function finish(value) {
    const current = operation;
    if (!current) return;
    operation = null;
    clearTimeout(current.timer);
    clearInterval(current.poll);
    try { current.baseline?.$dispose(); } catch { /* Agent unload also releases wrappers. */ }
    current.baseline = null;
    current.username = '';
    result = value;
    current.resolve(value);
  }

  function observeAuth(current) {
    if (operation !== current) return;
    const auth = javaField(User, 'd');
    if (!auth || (current.baseline && auth.equals(current.baseline))) return;
    const code = Number(auth.code.value);
    if (!Number.isSafeInteger(code)) return;
    if (code === 0) {
      const user = auth.user.value;
      if (!user || !auth.service.value) return;
      const actual = String(user.user_name.value).trim();
      const normalized = actual.includes('@') ? actual : actual + String(Configuration.d.value);
      if (normalized !== current.username) return;
    }
    finish({ authenticated: code === 0, code });
  }

  async function attach() {
    if (closed) throw fail('LOGIN_AGENT_CLOSED');
    if (attached) return { attached: true };
    await javaTask(() => {
      const App = step('LOGIN_APPLICATION_CLASS_FAILED', () => Java.use('org.bitspark.android.SpkApplication'));
      const app = step('LOGIN_APPLICATION_FIELD_FAILED', () => App.m.value);
      if (!app) throw fail('LOGIN_APPLICATION_NOT_READY');
      const packageName = step('LOGIN_PACKAGE_LOOKUP_FAILED', () => String(app.getPackageName()));
      if (packageName !== PACKAGE) throw fail('LOGIN_WRONG_APPLICATION');
      const manager = step('LOGIN_PACKAGE_MANAGER_FAILED', () => app.getPackageManager());
      const info = step('LOGIN_VERSION_LOOKUP_FAILED', () => manager.getPackageInfo(PACKAGE, 0));
      const version = step('LOGIN_VERSION_FIELD_FAILED', () => Number(info.versionCode.value));
      if (version !== 1190) throw fail('LOGIN_UNSUPPORTED_VERSION');
      Spark = step('LOGIN_ACTIVITY_CLASS_FAILED', () => Java.use('org.bitspark.android.Spark'));
      User = step('LOGIN_USER_CLASS_FAILED', () => Java.use('td.m'));
      Preferences = step('LOGIN_PREFERENCES_CLASS_FAILED', () => Java.use('org.bitspark.android.utils.i0'));
      Keys = step('LOGIN_KEYS_CLASS_FAILED', () => Java.use('org.bitspark.android.g'));
      Configuration = step('LOGIN_CONFIGURATION_CLASS_FAILED', () => Java.use('org.bitspark.android.h'));
      callback = step('LOGIN_CALLBACK_OVERLOAD_FAILED', () => User.k.overload('int', 'java.lang.String', 'java.lang.String'));
      previous = callback.implementation;
      if (previous) throw fail('LOGIN_METHOD_ALREADY_INSTRUMENTED');
      const implementation = function (httpStatus, username, body) {
        // Always preserve the real callback, its response, and any exceptions.
        const returned = callback.call(this, httpStatus, username, body);
        try {
          if (operation && String(username) === operation.username) {
            observeAuth(operation);
          }
        } catch { /* Never log the body, arguments, token or raw exception. */ }
        return returned;
      };
      step('LOGIN_CALLBACK_INSTALL_FAILED', () => { callback.implementation = implementation; });
      attached = true;
    });
    return { attached: true };
  }

  async function login(input) {
    if (!attached || closed) throw fail('LOGIN_AGENT_NOT_ATTACHED');
    if (operation) throw fail('LOGIN_BUSY');
    // One submit per attachment. A late response after a timeout must never
    // be mistaken for the result of another submit with the same username.
    if (used) throw fail('LOGIN_ALREADY_SUBMITTED');
    used = true;
    let credentials;
    const timeoutMs = Math.max(1000, Math.min(90000, Number(input?.timeoutMs) || 60000));
    let resolveResult;
    const pending = new Promise(resolve => { resolveResult = resolve; });
    // Set busy before scheduling onto the main thread, so two calls cannot race.
    const current = { username: '', resolve: resolveResult, timer: setTimeout(() => {
      finish({ authenticated: false, error: 'LOGIN_TIMEOUT' });
    }, timeoutMs) };
    operation = current;
    try {
      await javaTask(() => {
        if (operation !== current) throw fail('LOGIN_TIMEOUT');
        const handler = Spark.g3.value;
        if (!handler) throw fail('LOGIN_ACTIVITY_NOT_READY');
        credentials = normalizedCredentials(input, String(Configuration.d.value));
        operation.username = credentials.username;
        const before = javaField(User, 'd');
        current.baseline = before ? Java.retain(before) : null;
        // Exact be.e.onClick sequence: mode 1; normalized username; trimmed
        // password; EVENT_SUBMIT_USERNAME_PASSWORD (13) on the app Handler.
        Preferences.t.overload('int', 'java.lang.String').call(Preferences, 1, Keys.b.value);
        const put = Preferences.u.overload('java.lang.String', 'java.lang.String');
        put.call(Preferences, Keys.e.value, credentials.username);
        put.call(Preferences, Keys.f.value, credentials.password);
        if (!handler.sendEmptyMessage(13)) throw fail('LOGIN_HANDLER_REJECTED');
      }, true);
      // The protected VM can complete authentication without traversing the
      // Java hook. Observe the real state too, requiring a NEW AuthInfo object
      // for this submit so a cached session cannot turn a rejected login into
      // success. Never manufacture a response or change the original state.
      if (operation === current) current.poll = setInterval(() => {
        javaTask(() => observeAuth(current))
          .catch(() => { /* Timeout stays explicit if state cannot be read. */ });
      }, 250);
      return await pending;
    } catch (error) {
      finish({ authenticated: false, error: error.code || 'LOGIN_JAVA_CALL_FAILED' });
      throw error;
    } finally {
      if (credentials) { credentials.username = ''; credentials.password = ''; }
      input = null;
    }
  }

  async function status() {
    if (!attached || closed) throw fail('LOGIN_AGENT_NOT_ATTACHED');
    return javaTask(() => {
      const Core = Java.use('com.tvbus.engine.TVCore');
      const core = Core.inst.value;
      return {
        attached: true, pending: !!operation, result,
        activityReady: !!Spark.g3.value,
        engineCreated: !!core && String(Core.nativeHandle.value) !== '0',
        listenerReady: !!core?.tvListener.value,
      };
    });
  }

  async function setupTV() {
    if (!attached || closed || operation) throw fail('LOGIN_SETUP_NOT_READY');
    const dialogs = [];
    // Inspect only the original first-run dialog for this Activity. Its three
    // resource IDs are from Spark.onCreate in APK 1190, not guessed selectors.
    await javaTask(() => new Promise((resolve, reject) => {
      const handler = Spark.g3.value;
      if (!handler) return reject(fail('LOGIN_ACTIVITY_NOT_READY'));
      const activityObject = javaField(handler, 'a').get();
      if (!activityObject) return reject(fail('LOGIN_ACTIVITY_NOT_READY'));
      const ContextWrapper = Java.use('android.content.ContextWrapper');
      const ownsDialog = dialog => {
        let context = dialog.getContext();
        for (let depth = 0; context && depth < 5; depth++) {
          if (context.equals(activityObject)) return true;
          try { context = Java.cast(context, ContextWrapper).getBaseContext(); }
          catch { return false; }
        }
        return false;
      };
      Java.choose('android.app.Dialog', {
        onMatch(dialog) {
          try {
            if (dialog.isShowing() && ownsDialog(dialog)
                && dialog.findViewById(0x7f0b02cc) && dialog.findViewById(0x7f0b02cb)
                && dialog.findViewById(0x7f0b00a2)) dialogs.push(Java.retain(dialog));
          } catch { /* Ignore unrelated dialogs. */ }
        },
        onComplete: resolve,
      });
    }));
    try {
      return await javaTask(() => {
        const activityObject = javaField(Spark.g3.value, 'a').get();
        if (!activityObject) throw fail('LOGIN_ACTIVITY_NOT_READY');
        const activity = Java.cast(activityObject, Spark);
        const configured = Number(Preferences.j.overload('int', 'java.lang.String')
          .call(Preferences, -1, 'SP_DEVICE_TYPE').intValue());
        if (configured !== -1 || javaField(activity, 'U')) throw fail('LOGIN_DEVICE_ALREADY_CONFIGURED');
        if (dialogs.length !== 1) throw fail('LOGIN_SETUP_DIALOG_UNAVAILABLE');
        const model = javaField(activity, 'D0');
        if (!model) throw fail('LOGIN_VIEWMODEL_NOT_READY');
        // Same order as ae.p1.onClick: set type, dismiss, initialize. ue.r.e()
        // proves 1 is phone, hence 0 is TV. No auth/certificate state is changed.
        model.setDeviceType(0);
        dialogs[0].dismiss();
        activity.v();
        return { configured: true, deviceType: 'tv', loginFragmentReady: !!javaField(activity, 'U') };
      }, true);
    } finally {
      for (const dialog of dialogs) dialog.$dispose();
    }
  }

  async function detach() {
    finish({ authenticated: false, error: 'LOGIN_AGENT_DETACHED' });
    if (attached) await javaTask(() => { callback.implementation = previous; });
    attached = false; closed = true;
    return { detached: true };
  }
  return { attach, login, status, setuptv: setupTV, detach };
}
