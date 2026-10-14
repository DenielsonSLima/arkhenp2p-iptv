#!/usr/bin/env python3
"""Check original APK readiness, returning booleans only. Never submit login."""
import argparse
import json
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', choices=['127.0.0.1:27043'], required=True)
    args = parser.parse_args()
    result = {'ready': False, 'authenticated': False}
    session = script = None
    try:
        import frida
        if frida.__version__ != '17.8.0':
            raise ValueError('version')
        device = frida.get_device_manager().add_remote_device(args.endpoint)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                if script is None:
                    apps = [app for app in device.enumerate_applications()
                            if app.identifier == 'io.wareztv.android.one'
                            and type(app.pid) is int and app.pid > 0]
                    if len(apps) != 1:
                        time.sleep(0.75)
                        continue
                    session = device.attach(apps[0].pid)
                    script = session.create_script(Path(__file__).with_name('readiness-agent.bundle.js').read_text())
                    script.on('message', lambda message, data: None)
                    script.load()
                state = script.exports_sync.status()
                result = {key: state[key] for key in ('ready', 'authenticated', 'engineReady')
                          if type(state.get(key)) is bool}
                if state.get('error') == 'P2P_APK_VERSION':
                    result['error'] = 'P2P_APK_VERSION'
                    break
                if result.get('ready'):
                    break
            except Exception:
                result = {'ready': False, 'authenticated': False, 'error': 'P2P_READINESS_FAILED'}
                break
            time.sleep(0.75)
    except Exception:
        result = {'ready': False, 'authenticated': False, 'error': 'P2P_READINESS_FAILED'}
    finally:
        if script:
            try:
                script.unload()
            except Exception:
                pass
        if session:
            try:
                session.detach()
            except Exception:
                pass
    # Only this constrained result is output; no raw Frida exceptions or objects.
    print(json.dumps(result, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
