#!/bin/bash
# Builds and signs the Android TV kiosk app (Silva Signage player) without Gradle.
# Usage: OUT=/path/silva-signage-tv.apk TV_KEYSTORE_B64=... TV_KEYSTORE_PASSWORD=... bash build-apk.sh
# Downloads a JDK and the Android SDK into $TOOLS (default: ../../node_modules/.cache/android) on first run.
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-$PWD/build/silva-signage-tv.apk}
TOOLS=${TOOLS:-$(cd ../.. && pwd)/node_modules/.cache/android}
mkdir -p "$TOOLS"

# 1. JDK (Temurin 17) unless one is already on the PATH
if command -v javac >/dev/null 2>&1; then JAVA_BIN=$(dirname "$(command -v javac)"); else
  if [ ! -x "$TOOLS/jdk/bin/javac" ]; then
    curl -fsSL -o "$TOOLS/jdk.tgz" "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
    mkdir -p "$TOOLS/jdk" && tar -xzf "$TOOLS/jdk.tgz" -C "$TOOLS/jdk" --strip-components=1 && rm "$TOOLS/jdk.tgz"
  fi
  JAVA_BIN=$TOOLS/jdk/bin
fi
export JAVA_HOME=$(dirname "$JAVA_BIN") PATH=$JAVA_BIN:$PATH

# 2. Android SDK: command-line tools, platform 34, build-tools 34
SDK=$TOOLS/sdk
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -fsSL -o "$TOOLS/cmd.zip" https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  mkdir -p "$SDK/cmdline-tools" && (cd "$SDK/cmdline-tools" && jar xf "$TOOLS/cmd.zip") && rm "$TOOLS/cmd.zip"
  rm -rf "$SDK/cmdline-tools/latest" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  chmod +x "$SDK/cmdline-tools/latest/bin/"*
fi
BT=$SDK/build-tools/34.0.0; AJ=$SDK/platforms/android-34/android.jar
if [ ! -f "$AJ" ] || [ ! -x "$BT/aapt2" ]; then
  (yes 2>/dev/null || true) | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0" >/dev/null || true
  chmod +x "$BT/"* 2>/dev/null || true
fi
test -f "$AJ" && test -x "$BT/aapt2"

# 3. Compile, dex, package, align, sign
B=$(mktemp -d)
"$BT/aapt2" compile --dir res -o "$B/res.zip"
"$BT/aapt2" link -o "$B/unsigned.apk" -I "$AJ" --manifest AndroidManifest.xml --min-sdk-version 21 --target-sdk-version 34 --java "$B/gen" "$B/res.zip"
mkdir -p "$B/obj" "$B/dex"
javac -nowarn -source 8 -target 8 -bootclasspath "$AJ" -classpath "$AJ" -d "$B/obj" $(find src "$B/gen" -name '*.java') 2>&1 | grep -v -E "^(warning|Note|1 warning)" || true
"$BT/d8" --release --min-api 21 --lib "$AJ" --output "$B/dex" $(find "$B/obj" -name '*.class')
(cd "$B/dex" && jar -u -M -f "$B/unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"
if [ -n "${TV_KEYSTORE_B64:-}" ]; then
  echo "$TV_KEYSTORE_B64" | base64 -d > "$B/release.jks"
  "$BT/apksigner" sign --ks "$B/release.jks" --ks-key-alias silva --ks-pass env:TV_KEYSTORE_PASSWORD --out "$B/signed.apk" "$B/aligned.apk"
else
  echo "No TV_KEYSTORE_B64: signing with a throwaway debug key (installs, but updates will need a reinstall)." >&2
  keytool -genkeypair -keystore "$B/debug.jks" -alias silva -keyalg RSA -keysize 2048 -validity 3650 -storepass android -dname "CN=Debug" >/dev/null 2>&1
  "$BT/apksigner" sign --ks "$B/debug.jks" --ks-key-alias silva --ks-pass pass:android --out "$B/signed.apk" "$B/aligned.apk"
fi
"$BT/apksigner" verify "$B/signed.apk"
mkdir -p "$(dirname "$OUT")" && cp "$B/signed.apk" "$OUT"
"$BT/aapt2" dump badging "$OUT" | grep -E "^package:|leanback-launchable" || true
echo "Built $OUT ($(wc -c < "$OUT") bytes)"
rm -rf "$B"
