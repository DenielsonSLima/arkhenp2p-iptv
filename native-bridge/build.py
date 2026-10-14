#!/usr/bin/env python3
"""Compile/package the local TVBus facade without running/installing the APK."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
EXPECTED_APK = '2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69'
parser = argparse.ArgumentParser()
parser.add_argument('--sdk', default=str(Path.home() / 'Library/Android/sdk'))
parser.add_argument('--java-home')
parser.add_argument('--apk', default=str(PROJECT / 'WPLAYP2P.apk'))
args = parser.parse_args()
sdk = Path(args.sdk)
java = Path(args.java_home or subprocess.check_output(['/usr/libexec/java_home'], text=True).strip())
tools = sdk / 'build-tools/36.0.0'
android = sdk / 'platforms/android-36/android.jar'
apk = Path(args.apk)
if hashlib.sha256(apk.read_bytes()).hexdigest() != EXPECTED_APK:
    raise SystemExit('APK identity differs from the inspected WPLAYP2P 11.9.0d artifact.')
for required in [java / 'bin/javac', java / 'bin/keytool', android, tools / 'aapt2', tools / 'd8', tools / 'zipalign', tools / 'apksigner']:
    if not required.exists():
        raise SystemExit(f'Missing existing toolchain file: {required}')
build = HERE / 'build'
classes = build / 'classes'
dex = build / 'dex'
for directory in [classes, dex]:
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
env = {**os.environ, 'JAVA_HOME': str(java)}
def run(command):
    subprocess.run([str(value) for value in command], cwd=HERE, env=env, check=True)

sources = sorted((HERE / 'src').rglob('*.java'))
run([java / 'bin/javac', '--release', '8', '-classpath', android, '-d', classes, *sources])
run([tools / 'd8', '--min-api', '26', '--lib', android, '--output', dex, *sorted(classes.rglob('*.class'))])
unsigned = build / 'bridge-unsigned.apk'
run([tools / 'aapt2', 'link', '--manifest', HERE / 'AndroidManifest.xml', '-I', android, '--min-sdk-version', '26', '--target-sdk-version', '28', '-o', unsigned])
with zipfile.ZipFile(apk) as original, zipfile.ZipFile(unsigned, 'a') as output:
    output.write(dex / 'classes.dex', 'classes.dex', compress_type=zipfile.ZIP_DEFLATED)
    member = 'lib/arm64-v8a/libtvcore.so'
    output.writestr(member, original.read(member), compress_type=zipfile.ZIP_STORED)
aligned = build / 'bridge-aligned.apk'
run([tools / 'zipalign', '-P', '16', '-f', '4', unsigned, aligned])
keystore = build / 'local-debug.keystore'
if not keystore.exists():
    run([java / 'bin/keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'local-build-only', '-keypass', 'local-build-only', '-alias', 'local-bridge', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=ARKHEN Local Bridge,O=Local Development,C=BR'])
result = build / 'arkhen-tvbus-bridge.apk'
run([tools / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:local-build-only', '--key-pass', 'pass:local-build-only', '--ks-key-alias', 'local-bridge', '--out', result, aligned])
run([tools / 'apksigner', 'verify', '--verbose', result])
run([tools / 'zipalign', '-c', '-P', '16', '4', result])
summary = {
    'status': 'compiled_not_installed_or_executed',
    'package': 'io.arkhen.p2p.bridge',
    'sourceApkSha256': EXPECTED_APK,
    'apkSha256': hashlib.sha256(result.read_bytes()).hexdigest(),
    'apkBytes': result.stat().st_size,
    'nativeEngine': 'libtvcore.so, original ARM64 payload',
    'runtimeVerified': False,
    'controls': {'bind': '127.0.0.1', 'port': 62731, 'authentication': 'private app bridge-key file, >=32 bytes'},
    'hls': {'port': 8902, 'path': 'reported by the real onPrepared native callback'},
}
(build / 'build-report.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
