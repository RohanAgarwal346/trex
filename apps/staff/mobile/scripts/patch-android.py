#!/usr/bin/env python3
"""Run after `npx cap add android`: adds GPS permissions, version numbers and APK signing. Usage: patch-android.py <versionCode> <versionName>"""
import os, re, sys
code, name = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(__file__), '..')
man = os.path.join(root, 'android/app/src/main/AndroidManifest.xml')
s = open(man).read()
if 'ACCESS_FINE_LOCATION' not in s:
    s = s.replace('<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />')
    s = s.replace('<application', '<application android:usesCleartextTraffic="true"', 1) if 'usesCleartextTraffic' not in s else s
    open(man, 'w').write(s)
g = os.path.join(root, 'android/app/build.gradle')
b = open(g).read()
b = re.sub(r'versionCode \d+', f'versionCode {code}', b, 1)
b = re.sub(r'versionName "[^"]*"', f'versionName "{name}"', b, 1)
if 'signingConfigs' not in b and os.environ.get('KEYSTORE_PATH'):
    sign = '''    signingConfigs {
        ropo {
            storeFile file(System.getenv("KEYSTORE_PATH"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.ropo'''
    b = b.replace('    buildTypes {\n        release {', sign, 1)
open(g, 'w').write(b)
print('patched', code, name)
