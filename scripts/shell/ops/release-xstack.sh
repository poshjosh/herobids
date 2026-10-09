#!/usr/bin/env bash
#
# Usage:
#   scripts/shell/ops/release.sh <traderton-version> <herobids-version>
#   scripts/shell/ops/release.sh 0.1.2 0.6.6

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TRADERTON_DIR="${PARENT_DIR}/traderton"
HEROBIDS_DIR="${PARENT_DIR}/herobids"

TRADERTON_VERSION=""
HEROBIDS_VERSION=""


while [[ $# -gt 0 ]]; do
  case "$1" in
    --tv)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --tv requires a Traderton version (e.g. 0.1.2)" >&2
        exit 1
      fi
      TRADERTON_VERSION="$2"
      shift 2
      ;;
    --hv)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --hv requires a Herobids version (e.g. 0.6.6)" >&2
        exit 1
      fi
      HEROBIDS_VERSION="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      echo "Usage: $0 --tv <major.minor.patch> --hv <major.minor.patch>" >&2
      exit 1
      ;;
  esac
done

# Require both versions
if [[ -z "$TRADERTON_VERSION" || -z "$HEROBIDS_VERSION" ]]; then
  echo "Error: Both --tv and --hv are required." >&2
  echo "Usage: $0 --tv <major.minor.patch> --hv <major.minor.patch>" >&2
  exit 1
fi

# Validate strict major.minor.patch format (numeric components only)
VERSION_REGEX='^[0-9]+\.[0-9]+\.[0-9]+$'

if [[ ! "$TRADERTON_VERSION" =~ $VERSION_REGEX ]]; then
  echo "Error: Invalid Traderton version '$TRADERTON_VERSION'. Expected major.minor.patch (e.g. 0.1.2)." >&2
  exit 1
fi

if [[ ! "$HEROBIDS_VERSION" =~ $VERSION_REGEX ]]; then
  echo "Error: Invalid Herobids version '$HEROBIDS_VERSION'. Expected major.minor.patch (e.g. 0.6.6)." >&2
  exit 1
fi

run_step() {
  local description="$1"
  shift

  echo ""
  echo "==> $description"

  if "$@"; then
    echo "SUCCESS: $description"
  else
    local exit_code=$?
    echo "ERROR: $description failed (exit code: $exit_code). Aborting release." >&2
    exit "$exit_code"
  fi
}

run_step "Release Traderton v$TRADERTON_VERSION" \
  bash -c 'cd "$1" && scripts/shell/ops/release.sh "$2" --all' _ \
  "$TRADERTON_DIR" "$TRADERTON_VERSION"

run_step "Release Herobids v$HEROBIDS_VERSION" \
  bash -c 'cd "$1" && scripts/shell/ops/release.sh "$2" --all' _ \
  "$HEROBIDS_DIR" "$HEROBIDS_VERSION"

run_step "Bump Traderton parity pin to Herobids v$HEROBIDS_VERSION" \
  bash -c 'cd "$1" && scripts/shell/ops/release.sh --bump-parity-pin "$2"' _ \
  "$TRADERTON_DIR" "v$HEROBIDS_VERSION"

run_step "Bump Herobids parity pin to Traderton v$TRADERTON_VERSION" \
  bash -c 'cd "$1" && scripts/shell/ops/release.sh --bump-parity-pin "$2"' _ \
  "$HEROBIDS_DIR" "v$TRADERTON_VERSION"

echo ""
echo "==> Committing and pushing traderton .github/workflows/slow-tests.yml"
cd "$TRADERTON_DIR" && git add .github/workflows/slow-tests.yml && git commit -m "Update slow-tests.yml for release v$TRADERTON_VERSION" && git push

echo ""
echo "==> Committing and pushing herobids .github/workflows/slow-tests.yml"
cd "$HEROBIDS_DIR" && git add .github/workflows/slow-tests.yml && git commit -m "Update slow-tests.yml for release v$HEROBIDS_VERSION" && git push

echo ""
echo "==>All release steps completed successfully."
