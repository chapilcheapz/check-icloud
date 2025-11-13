#!/usr/bin/env bash
set -e
# macOS: install libimobiledevice via brew if missing
if ! command -v ideviceinfo >/dev/null 2>&1; then
  echo "ideviceinfo not found — attempting to brew install libimobiledevice (requires Homebrew)"
  brew install libimobiledevice --HEAD usbmuxd || true
fi
npm install
npm start
