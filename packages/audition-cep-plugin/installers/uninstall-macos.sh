#!/usr/bin/env bash
# AVAPARDAZ — macOS Uninstaller (preserves user transcripts & models by default)
set -euo pipefail

PLUGIN_ID="ir.avapardaz.audition.cep"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$PLUGIN_ID"
APP_SUPPORT="$HOME/Library/Application Support/AVAPARDAZ"

echo "[AVAPARDAZ] Removing Adobe Audition CEP plugin..."
rm -rf "$CEP_DIR"
rm -rf "$APP_SUPPORT/runtime"

if [[ "${AVAPARDAZ_REMOVE_MODELS:-0}" == "1" ]]; then
  echo "[AVAPARDAZ] Removing downloaded AI models as explicitly requested..."
  rm -rf "$APP_SUPPORT/models"
else
  echo "[AVAPARDAZ] Preserved AI models and user transcripts in: $APP_SUPPORT"
fi

echo "[AVAPARDAZ] Uninstall complete."
