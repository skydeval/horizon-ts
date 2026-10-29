#!/usr/bin/env bash
# Build a signed Horizon release APK on silonew from ~/horizon/horizon-ts.
#   android-build.sh            build (arm64), APK to ~/horizon/apk/
#   android-build.sh keyinfo    print the signing certificate's fingerprints
# The release keystore lives in ~/horizon-keys (never in the repo). It is made
# once; losing it means installed copies can never be updated, so back it up.
set -euo pipefail

source "$HOME/android-tools/env.sh"
export PATH="$HOME/.local/node-v24.22.1/bin:$PATH"

APP="$HOME/horizon/horizon-ts"
KEYS="$HOME/horizon-keys"
STORE="$KEYS/horizon-release.jks"
ALIAS="horizon"
OUT="$HOME/horizon/apk"

make_keystore() {
  mkdir -p "$KEYS"
  chmod 700 "$KEYS"
  if [ ! -f "$KEYS/keystore.env" ]; then
    umask 077
    printf 'HORIZON_KEYSTORE_PASSWORD=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)" > "$KEYS/keystore.env"
  fi
  # shellcheck disable=SC1091
  source "$KEYS/keystore.env"
  if [ ! -f "$STORE" ]; then
    echo "== creating the release keystore (back up $KEYS)"
    keytool -genkeypair -v -keystore "$STORE" -alias "$ALIAS" \
      -keyalg RSA -keysize 4096 -validity 10000 \
      -storepass "$HORIZON_KEYSTORE_PASSWORD" -keypass "$HORIZON_KEYSTORE_PASSWORD" \
      -dname "CN=Horizon, O=Horizon, C=US" > /dev/null
    chmod 600 "$STORE"
  fi
}

if [ "${1:-build}" = "keyinfo" ]; then
  make_keystore
  keytool -list -v -keystore "$STORE" -alias "$ALIAS" \
    -storepass "$HORIZON_KEYSTORE_PASSWORD" | grep -E "SHA1:|SHA256:"
  exit 0
fi

make_keystore
cd "$APP"

echo "== install"
CI=true npx --no-install pnpm install --frozen-lockfile

echo "== strings (Horizon's own, as the web build does)"
npx --no-install pnpm intl:extract:all > /dev/null
npx --no-install pnpm intl:compile > /dev/null

echo "== google-services.json (example, package renamed; push is off)"
sed 's/"package_name": "xyz.blueskyweb.app"/"package_name": "app.nearhorizon"/' \
  google-services.json.example > google-services.json

echo "== prebuild"
EXPO_PUBLIC_ENV=production EXPO_NO_GIT_STATUS=1 CI=1 \
  npx --no-install expo prebuild --platform android --clean --no-install

echo "== gradle assembleRelease (arm64)"
cd android
EXPO_PUBLIC_ENV=production NODE_ENV=production ./gradlew --no-daemon \
  assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.injected.signing.store.file="$STORE" \
  -Pandroid.injected.signing.store.password="$HORIZON_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$ALIAS" \
  -Pandroid.injected.signing.key.password="$HORIZON_KEYSTORE_PASSWORD"

mkdir -p "$OUT"
SHA="$(cat "$APP/.build-sha" 2>/dev/null || echo local)"
cp app/build/outputs/apk/release/app-release.apk "$OUT/horizon-$SHA.apk"
# The Hermes-composed source map, to turn a crash's bundle offsets into lines
MAP=app/build/generated/sourcemaps/react/release/index.android.bundle.map
if [ -f "$MAP" ]; then cp "$MAP" "$OUT/horizon-$SHA.map"; fi
echo "== APK: $OUT/horizon-$SHA.apk"
ls -la "$OUT/horizon-$SHA".*
