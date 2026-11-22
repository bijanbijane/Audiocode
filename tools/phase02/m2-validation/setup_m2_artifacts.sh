#!/usr/bin/env bash
# AVAPARDAZ — PHASE-02 Authorized M2 (macOS arm64) Artifact Installer
# Downloads official sherpa-onnx macOS arm64 runtime, verified Apache-2.0/MIT models,
# and verifies SHA-256 digests before marking artifacts ready for offline M2 execution.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS_DIR="$SCRIPT_DIR/artifacts"
RUNTIME_DIR="$ARTIFACTS_DIR/runtime"
MODELS_DIR="$ARTIFACTS_DIR/models"
DOWNLOADS_DIR="$ARTIFACTS_DIR/downloads"

mkdir -p "$RUNTIME_DIR" "$MODELS_DIR" "$DOWNLOADS_DIR"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: setup_m2_artifacts.sh is intended for macOS Apple Silicon (Darwin arm64)." >&2
  echo "Detected: $(uname -s) $(uname -m)" >&2
  exit 1
fi

echo "[1/4] Downloading sherpa-onnx v2.0.2 (macOS universal2/arm64)..."
SHERPA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-osx-universal2-shared.tar.bz2"
curl -fL -o "$DOWNLOADS_DIR/sherpa-onnx-osx.tar.bz2" "$SHERPA_URL"
tar -xjf "$DOWNLOADS_DIR/sherpa-onnx-osx.tar.bz2" -C "$RUNTIME_DIR" --strip-components=1

echo "[2/4] Downloading Reza2kn/Shenava-Rizeh v1.0 INT8 (Apache-2.0)..."
SHENAVA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26.tar.bz2"
curl -fL -o "$DOWNLOADS_DIR/shenava-rizeh.tar.bz2" "$SHENAVA_URL"
tar -xjf "$DOWNLOADS_DIR/shenava-rizeh.tar.bz2" -C "$MODELS_DIR"

echo "[3/4] Downloading openai/whisper-large-v3-turbo INT8 (MIT)..."
TURBO_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2"
curl -fL -o "$DOWNLOADS_DIR/whisper-turbo.tar.bz2" "$TURBO_URL"
tar -xjf "$DOWNLOADS_DIR/whisper-turbo.tar.bz2" -C "$MODELS_DIR"

echo "[4/4] Downloading english-mfa-v3.1.0 forced aligner (CC-BY-4.0)..."
MFA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/fa-models/english-mfa-v3.1.0.tar.bz2"
curl -fL -o "$DOWNLOADS_DIR/english-mfa-v3.1.0.tar.bz2" "$MFA_URL"
tar -xjf "$DOWNLOADS_DIR/english-mfa-v3.1.0.tar.bz2" -C "$MODELS_DIR"

echo "Verifying SHA-256 digests against config.json..."
python3 "$SCRIPT_DIR/m2_runner.py" --config "$SCRIPT_DIR/config.json" --verify-only

echo "SUCCESS: Local M2 artifacts installed and SHA-256 verified."
echo "Next: Run './run_m2_validation.sh --profile full' (with and without Adobe Audition running)."
