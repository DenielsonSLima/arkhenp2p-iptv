#!/usr/bin/env python3
"""Submit the intact APK's original login using a single JSON request on stdin.

Credentials stay out of argv, files and diagnostics. The original APK itself
persists its normal login preferences, just as when its login button is used.
This helper never installs, starts, patches or re-signs an APK.
"""
import argparse
import json
import re
import sys
from pathlib import Path

PACKAGE = 'io.wareztv.android.one'
SAFE_CODE = re.compile(r'\bLOGIN_[A-Z_]+\b')


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--agent', type=Path, default=Path(__file__).with_name('login-agent.bundle.js'))
    args = parser.parse_args()
    if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', args.endpoint):
        emit({'ok': False, 'error': 'LOGIN_INVALID_LOCAL_ENDPOINT'})
        return 2
    if not 1024 <= int(args.endpoint.rsplit(':', 1)[1]) <= 65535:
        emit({'ok': False, 'error': 'LOGIN_INVALID_LOCAL_ENDPOINT'})
        return 2
    session = script = exports = request = raw = None
    terminal_state = None
    try:
        # Disable echo before announcing readiness: write_stdin may otherwise
        # reflect the credential line into the PTY/tool transcript.
        if sys.stdin.isatty():
            import termios
            terminal_state = termios.tcgetattr(sys.stdin.fileno())
            private_state = list(terminal_state)
            private_state[3] &= ~(termios.ECHO | termios.ECHONL)
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, private_state)
        emit({'ok': True, 'event': 'input-ready'})
        # Bounded read; JSON remains in memory. No untrusted error strings leave.
        raw = sys.stdin.buffer.readline(8193)
        if not raw or len(raw) > 8192:
            raise ValueError('LOGIN_INVALID_INPUT')
        request = json.loads(raw)
        raw = None
        if not isinstance(request, dict) or set(request) - {'username', 'password', 'timeoutMs'}:
            raise ValueError('LOGIN_INVALID_INPUT')
        import frida
        device = frida.get_device_manager().add_remote_device(args.endpoint)
        matches = [app for app in device.enumerate_applications() if app.identifier == PACKAGE and app.pid]
        if len(matches) != 1:
            raise ValueError('LOGIN_APPLICATION_NOT_RUNNING')
        session = device.attach(matches[0].pid)
        script = session.create_script(args.agent.read_text())
        script.on('message', lambda message, data: None)
        script.load()
        exports = script.exports_sync
        exports.attach()
        result = exports.login(request)
        request.clear()
        # The agent returns booleans/numeric business code only; keep a second
        # explicit boundary here rather than forwarding arbitrary RPC objects.
        public = {'authenticated': result.get('authenticated') is True}
        if isinstance(result.get('code'), int):
            public['code'] = result['code']
        if isinstance(result.get('error'), str) and re.fullmatch(r'LOGIN_[A-Z_]+', result['error']):
            public['error'] = result['error']
        state = exports.status()
        public.update({k: state.get(k) is True for k in ['activityReady', 'engineCreated', 'listenerReady']})
        emit({'ok': public['authenticated'], 'result': public})
        return 0 if public['authenticated'] else 1
    except Exception as error:
        match = SAFE_CODE.search(str(error))
        emit({'ok': False, 'error': match.group(0) if match else 'LOGIN_RPC_FAILED'})
        return 1
    finally:
        if terminal_state is not None:
            try:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, terminal_state)
            except Exception:
                pass
        if isinstance(request, dict):
            request.clear()
        raw = None
        if exports:
            try:
                exports.detach()
            except Exception:
                pass
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


if __name__ == '__main__':
    sys.exit(main())
