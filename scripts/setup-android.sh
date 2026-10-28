#!/usr/bin/env bash
# One-time Android build setup for Horizon on silonew, all under $HOME (no sudo).
# Installs: Temurin JDK 17, Android cmdline-tools, platform 37, build-tools
# 37.0.0, NDK 27.1.12297006 (React Native 0.88's pin) and CMake 3.22.1.
set -euo pipefail

TOOLS="$HOME/android-tools"
JDK_DIR="$TOOLS/jdk-17"
SDK="$HOME/Android/Sdk"
mkdir -p "$TOOLS" "$SDK"

if [ ! -x "$JDK_DIR/bin/java" ]; then
  echo "== JDK 17"
  curl -fsSL -o "$TOOLS/jdk17.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  rm -rf "$JDK_DIR" "$TOOLS/jdk-tmp"
  mkdir -p "$TOOLS/jdk-tmp"
  tar -xzf "$TOOLS/jdk17.tar.gz" -C "$TOOLS/jdk-tmp"
  mv "$TOOLS"/jdk-tmp/jdk-17* "$JDK_DIR"
  rm -rf "$TOOLS/jdk-tmp" "$TOOLS/jdk17.tar.gz"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
java -version

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "== cmdline-tools"
  curl -fsSL -o "$TOOLS/cmdline-tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  rm -rf "$TOOLS/cmdline-tmp"
  mkdir -p "$TOOLS/cmdline-tmp" "$SDK/cmdline-tools"
  # Python's zipfile, in case unzip isn't installed
  python3 -m zipfile -e "$TOOLS/cmdline-tools.zip" "$TOOLS/cmdline-tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TOOLS/cmdline-tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  chmod +x "$SDK/cmdline-tools/latest/bin/"*
  rm -rf "$TOOLS/cmdline-tmp" "$TOOLS/cmdline-tools.zip"
fi
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"

echo "== licences"
yes | "$SDKM" --sdk_root="$SDK" --licenses > /dev/null || true

echo "== packages"
"$SDKM" --sdk_root="$SDK" --install \
  "platform-tools" \
  "platforms;android-37.0" \
  "build-tools;37.0.0" \
  "ndk;27.1.12297006" \
  "cmake;3.22.1"

cat > "$TOOLS/env.sh" <<EOF
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
EOF
echo "== done; source $TOOLS/env.sh"
"$SDKM" --sdk_root="$SDK" --list_installed
