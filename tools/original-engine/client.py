#!/usr/bin/env python3
"""Local JSONL transport for an already authenticated, intact APK.

stdin carries requests. stdout is a machine protocol, never a diagnostic log.
Only a successful start response may contain a validated local HLS URL.
No APK modification, process spawning, root changes, install or auth operations.
"""
import argparse
import json
import re
import sys
from pathlib import Path

PACKAGE = 'io.wareztv.android.one'
SAFE_CODE = re.compile(r'\b(?:AGENT|ENGINE|JAVA|LISTENER|METHOD|INVALID|LOCAL|NATIVE|EXTERNAL|REQUEST|STOP|PLAYBACK)_[A-Z_]+\b')
LOCAL_HLS = re.compile(r'^http://127\.0\.0\.1:8902/([0-9]{1,10})/(main|index)\.m3u8$')


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def error_code(error):
    # Frida exceptions may include arguments, URLs or source code in the stack.
    # Report only our enumerated uppercase diagnostic code.
    match = SAFE_CODE.search(str(error))
    return match.group(0) if match else 'ENGINE_RPC_FAILED'


def application_pid(device):
    # Frida's process name may be the application label ("WPlay"), not the
    # Android package. Resolve only the exact installed application identifier.
    matches = [app for app in device.enumerate_applications()
               if app.identifier == PACKAGE and type(app.pid) is int and app.pid > 0]
    if not matches:
        raise ValueError('ENGINE_PROCESS_NOT_RUNNING')
    if len(matches) != 1:
        raise ValueError('ENGINE_PROCESS_AMBIGUOUS')
    return matches[0].pid


def cleanup_attachment(exports, script, session, owned_request=None, already_detached=False):
    """Restore live hooks explicitly before unloading the Java bridge runtime."""
    if exports and not already_detached:
        try:
            if owned_request and exports.status().get('requestId') == owned_request:
                exports.stop(owned_request)
        except Exception:
            pass
        try:
            # Restores all original Java implementations and removes the native
            # observer before script.unload tears down the Java bridge itself.
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', required=True, help='Already-forwarded local Frida endpoint, 127.0.0.1:PORT')
    parser.add_argument('--agent', type=Path, default=Path(__file__).with_name('agent.bundle.js'))
    args = parser.parse_args()
    if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', args.endpoint):
        emit({'ok': False, 'error': 'INVALID_LOCAL_ENDPOINT'})
        return 2
    if not 1024 <= int(args.endpoint.rsplit(':', 1)[1]) <= 65535:
        emit({'ok': False, 'error': 'INVALID_LOCAL_ENDPOINT'})
        return 2
    try:
        import frida
    except ImportError:
        emit({'ok': False, 'error': 'ENGINE_FRIDA_NOT_INSTALLED'})
        return 2
    session = script = exports = None
    owned_request = None
    agent_detached = False
    try:
        device = frida.get_device_manager().add_remote_device(args.endpoint)
        session = device.attach(application_pid(device))
        script = session.create_script(args.agent.read_text())
        # Never forward console, raw exception stack or arbitrary agent messages.
        script.on('message', lambda message, data: None)
        script.load()
        exports = script.exports_sync
        emit({'ok': True, 'event': 'attached', 'result': exports.attach()})
        while True:
            line = sys.stdin.buffer.readline(65537)
            if not line:
                break
            if len(line) > 65536 or not line.endswith(b'\n'):
                emit({'ok': False, 'error': 'INVALID_REQUEST_SIZE'})
                break
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError('INVALID_REQUEST')
                op = request.get('op')
                if op == 'status':
                    result = exports.status()
                elif op == 'verifyAccount':
                    result = exports.verify_account(request.get('username')) is True
                elif op == 'start':
                    owned_request = request.get('requestId')
                    result = exports.start({key: request[key] for key in ['requestId', 'uri', 'timeoutMs'] if key in request})
                    match = LOCAL_HLS.fullmatch(result.get('hls', ''))
                    if not match or int(match.group(1)) > 0xffffffff:
                        raise ValueError('LOCAL_HLS_UNAVAILABLE')
                elif op == 'stop':
                    result = exports.stop(request.get('requestId'))
                    owned_request = None
                elif op == 'detach':
                    # End the owned playback before removing observers.
                    if owned_request and exports.status().get('requestId') == owned_request:
                        exports.stop(owned_request)
                    owned_request = None
                    result = exports.detach()
                    agent_detached = True
                    emit({'ok': True, 'op': op, 'result': result})
                    break
                else:
                    raise ValueError('INVALID_OPERATION')
                emit({'ok': True, 'op': op, 'result': result})
            except Exception as error:
                emit({'ok': False, 'error': error_code(error)})
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        emit({'ok': False, 'error': error_code(error)})
        return 1
    finally:
        cleanup_attachment(exports, script, session, owned_request, agent_detached)
    return 0


if __name__ == '__main__':
    sys.exit(main())
