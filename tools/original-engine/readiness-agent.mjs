import Java from 'frida-java-bridge';

// Read-only readiness check. No hooks, login, preferences, start/stop, or writes.
rpc.exports.status = () => new Promise(resolve => {
  if (!Java.available) return resolve({ ready: false, authenticated: false });
  Java.perform(() => {
    try {
      const App = Java.use('org.bitspark.android.SpkApplication');
      const app = App.m.value;
      if (!app) return resolve({ ready: false, authenticated: false });
      const name = String(app.getPackageName());
      if (name !== 'io.wareztv.android.one') return resolve({ error: 'P2P_APK_VERSION' });
      const info = app.getPackageManager().getPackageInfo(name, 0);
      if (Number(info.versionCode.value) !== 1190) return resolve({ error: 'P2P_APK_VERSION' });
      const field = Java.use('td.m').class.getDeclaredField('d');
      field.setAccessible(true);
      const value = field.get(null);
      let authenticated = false;
      if (value) {
        const auth = Java.cast(value, Java.use('org.bitspark.android.beans.AuthInfo'));
        authenticated = Number(auth.code.value) === 0 && !!auth.user.value && !!auth.service.value;
      }
      const Core = Java.use('com.tvbus.engine.TVCore');
      const core = Core.inst.value;
      const engineReady = !!core && String(Core.nativeHandle.value) !== '0' && !!core.tvListener.value;
      resolve({ ready: authenticated && engineReady, authenticated, engineReady });
    } catch { resolve({ ready: false, authenticated: false, error: 'P2P_READINESS_FAILED' }); }
  });
});
