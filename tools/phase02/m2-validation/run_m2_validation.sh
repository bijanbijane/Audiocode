#!/usr/bin/env bash
# AVAPARDAZ — PHASE-02 Portable Apple Silicon M2 / 8 GB CPU-Only Validation Kit
# Usage: ./run_m2_validation.sh [--auto-setup] --profile [smoke|full] [--allow-audition-absent] [--dry-run-preflight]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="full"
AUTO_SETUP=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-full}"
      shift 2
      ;;
    --auto-setup)
      AUTO_SETUP=1
      shift
      ;;
    --allow-audition-absent|--dry-run-preflight|--skip-long-audio)
      EXTRA_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--auto-setup] --profile [smoke|full] [--allow-audition-absent] [--dry-run-preflight]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required (macOS Xcode Command Line Tools or python.org Python 3.9+)." >&2
  exit 1
fi

if [[ "$AUTO_SETUP" -eq 1 ]]; then
  echo "Running explicit M2 artifact installation & SHA-256 verification stage..."
  bash "$SCRIPT_DIR/setup_m2_artifacts.sh"
fi

export AVP_M2_KIT_ROOT="$SCRIPT_DIR"
exec python3 "$SCRIPT_DIR/m2_runner.py" --config "$SCRIPT_DIR/config.json" --profile "$PROFILE" "${EXTRA_ARGS[@]}"
