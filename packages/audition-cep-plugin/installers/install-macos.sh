#!/usr/bin/env bash
# AVAPARDAZ — macOS Installer for Adobe Audition CEP Plugin & Local Companion
# Preserves user projects & transcripts on upgrade/repair.
set -euo pipefail

PLUGIN_ID="ir.avapardaz.audition.cep"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$PLUGIN_ID"
APP_SUPPORT="$HOME/Library/Application Support/AVAPARDAZ"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[AVAPARDAZ] Installing Adobe Audition CEP extension to: $CEP_DIR"
mkdir -p "$CEP_DIR" "$APP_SUPPORT/models" "$APP_SUPPORT/runtime" "$APP_SUPPORT/config"

cp -R "$SCRIPT_DIR/CSXS" "$CEP_DIR/"
cp -R "$SCRIPT_DIR/client" "$CEP_DIR/"
cp -R "$SCRIPT_DIR/jsx" "$CEP_DIR/"

if [[ "${AVAPARDAZ_ENABLE_CEP_DEBUG:-0}" == "1" ]]; then
  defaults write com.adobe.CSXS.11 PlayerDebugMode 1
  defaults write com.adobe.CSXS.12 PlayerDebugMode 1
  echo "[AVAPARDAZ] Enabled CEP PlayerDebugMode for internal beta testing."
fi

echo "[AVAPARDAZ] Installation complete. Restart Adobe Audition -> Window -> Extensions -> AVAPARDAZ."
