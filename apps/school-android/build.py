#!/usr/bin/env python3
"""Build a signed, universal APK with official Android SDK tools and Java 17.

No Gradle or Android Studio is required. Signing files must stay outside Git.
"""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
SDK = Path(os.environ['REVOLT_ANDROID_SDK']).resolve()
TOOLS = Path(os.environ.get('REVOLT_ANDROID_BUILD_TOOLS', SDK / 'android-15')).resolve()
PLATFORM = Path(os.environ.get('REVOLT_ANDROID_PLATFORM', SDK / 'android-35' / 'android.jar')).resolve()
SIGNING = Path(os.environ['REVOLT_ANDROID_SIGNING_DIR']).resolve()
OUTPUT = Path(os.environ.get('REVOLT_ANDROID_OUTPUT', ROOT / 'build' / 'Revolt-School-Android.apk')).resolve()
BUILD = ROOT / 'build'

def run(*args):
    subprocess.run([str(a) for a in args], check=True, cwd=ROOT)

def main():
    if BUILD.exists(): shutil.rmtree(BUILD)
    for path in [BUILD / 'classes', BUILD / 'dex', SIGNING, OUTPUT.parent]: path.mkdir(parents=True, exist_ok=True)
    os.chmod(SIGNING, 0o700)
    keystore = SIGNING / 'revolt-school.p12'
    password = SIGNING / 'keystore-password.txt'
    if not keystore.exists():
        password.write_text(secrets.token_urlsafe(36))
        os.chmod(password, 0o600)
        run('keytool', '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'revolt-school', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Revolt School, O=Revolt-X Technologies', '-storepass:file', password, '-keypass:file', password)
        os.chmod(keystore, 0o600)
    if not password.exists(): raise RuntimeError('The saved signing password is required to update this application.')
    run(TOOLS / 'aapt2', 'compile', '--dir', ROOT / 'res', '-o', BUILD / 'resources.zip')
    run(TOOLS / 'aapt2', 'link', '-o', BUILD / 'resources.apk', '--manifest', ROOT / 'AndroidManifest.xml', '-I', PLATFORM, '--min-sdk-version', '26', '--target-sdk-version', '35', '-A', ROOT / 'assets', BUILD / 'resources.zip')
    run('java', 'com.sun.tools.javac.Main', '--release', '8', '-cp', PLATFORM, '-d', BUILD / 'classes', *sorted((ROOT / 'src').rglob('*.java')))
    run('java', '-cp', TOOLS / 'lib' / 'd8.jar', 'com.android.tools.r8.D8', '--min-api', '26', '--lib', PLATFORM, '--output', BUILD / 'dex', *sorted((BUILD / 'classes').rglob('*.class')))
    unsigned = BUILD / 'unsigned.apk'; shutil.copyfile(BUILD / 'resources.apk', unsigned)
    with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as apk:
        for path in sorted((BUILD / 'dex').glob('*.dex')): apk.write(path, path.name)
    run(TOOLS / 'zipalign', '-f', '-p', '4', unsigned, BUILD / 'aligned.apk')
    run('java', '-jar', TOOLS / 'lib' / 'apksigner.jar', 'sign', '--ks', keystore, '--ks-key-alias', 'revolt-school', '--ks-pass', 'file:' + str(password), '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--out', OUTPUT, BUILD / 'aligned.apk')
    run('java', '-jar', TOOLS / 'lib' / 'apksigner.jar', 'verify', '--verbose', '--print-certs', OUTPUT)
    run(TOOLS / 'zipalign', '-c', '4', OUTPUT)
    print('APK:', OUTPUT)
    print('Bytes:', OUTPUT.stat().st_size)
    print('SHA-256:', hashlib.sha256(OUTPUT.read_bytes()).hexdigest())

if __name__ == '__main__': main()
