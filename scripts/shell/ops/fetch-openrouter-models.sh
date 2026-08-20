#!/usr/bin/env bash
# fetch-openrouter-models.sh — Fetch the live OpenRouter model catalog (ids,
# context length, and per-1M-token pricing) directly from OpenRouter's public
# /v1/models endpoint.
#
# Self-contained: no repo build, no .env file, no database, and no API key
# required — OpenRouter's model list is a public, unauthenticated endpoint.
# If OPENROUTER_API_KEY or LLM_API_KEY_OPENROUTER is set in your shell
# environment, it is sent as a Bearer token, but this is optional.
#
# This is a standalone read-only convenience tool for humans. It does not
# write to config/providers.yaml or the DB — the running platform's own
# pricing snapshot pipeline is packages/llm/src/openrouter-pricing.ts,
# refreshed hourly by the worker (see docs/best-practices/llm-providers.md).
#
# Setup:
#   chmod +x scripts/shell/ops/fetch-openrouter-models.sh
#
# Usage:
#   scripts/shell/ops/fetch-openrouter-models.sh
#   scripts/shell/ops/fetch-openrouter-models.sh --search deepseek
#   scripts/shell/ops/fetch-openrouter-models.sh --limit 20
#   scripts/shell/ops/fetch-openrouter-models.sh --raw
#   scripts/shell/ops/fetch-openrouter-models.sh --no-save
#   scripts/shell/ops/fetch-openrouter-models.sh --help
#
# Requires: curl, jq (both must already be on PATH).
#
# Output:
#   Prints a summary table (id, context length, input/output $ per 1M tokens)
#   to stdout, sorted by model id. The full raw JSON response is also saved
#   to .ignore/openrouter-models/ (gitignored) unless --no-save is passed.
#
# Exit codes:
#   0  Success
#   1  Missing dependency, network/API failure, or bad arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OPENROUTER_MODELS_URL="https://openrouter.ai/api/v1/models"
OUTPUT_DIR="$REPO_ROOT/.ignore/openrouter-models"

SEARCH=""
LIMIT=0
RAW=0
SAVE=1
JSON_OUT=""
API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY_OPENROUTER:-}}"

# ---------------------------------------------------------------------------
# Logging — always stderr, so stdout stays clean for piping (e.g. --raw | jq)
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%H:%M:%S')] $*" >&2; }
die()  { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Fetch the live OpenRouter model catalog. No setup required — no .env file,
no database, no API key. Just curl + jq.

Options:
  --search TEXT     Only show models whose id contains TEXT (case-insensitive)
  --limit N         Show at most N models (default: all)
  --raw             Print the raw JSON response instead of the summary table
  --json-out PATH   Save the raw JSON response to PATH
                    (default: $OUTPUT_DIR/models-<timestamp>.json)
  --no-save         Do not save a JSON snapshot to disk
  --api-key KEY     Bearer token to send. Optional — OpenRouter's model list
                    is public. Defaults to \$OPENROUTER_API_KEY or
                    \$LLM_API_KEY_OPENROUTER if either is set in your shell.
  -h, --help        Show this message

Examples:
  $(basename "$0")
  $(basename "$0") --search claude
  $(basename "$0") --limit 20
  $(basename "$0") --raw --no-save
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --search)   SEARCH="$2"; shift 2 ;;
    --limit)    LIMIT="$2"; shift 2 ;;
    --raw)      RAW=1; shift ;;
    --json-out) JSON_OUT="$2"; SAVE=1; shift 2 ;;
    --no-save)  SAVE=0; shift ;;
    --api-key)  API_KEY="$2"; shift 2 ;;
    -h|--help)  usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die "'curl' is required but not found in PATH."
command -v jq   >/dev/null 2>&1 || die "'jq' is required but not found in PATH. Install: brew install jq (macOS) or apt install jq (Linux)."

# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

log "Fetching OpenRouter model catalog from $OPENROUTER_MODELS_URL"

CURL_ARGS=(--fail --silent --show-error --location --max-time 20)
if [[ -n "$API_KEY" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer $API_KEY")
fi
CURL_ARGS+=("$OPENROUTER_MODELS_URL")

RESPONSE="$(curl "${CURL_ARGS[@]}")" || die "Request to OpenRouter failed. Check network connectivity."

echo "$RESPONSE" | jq -e '.data' >/dev/null 2>&1 || die "Unexpected response shape from OpenRouter (no .data array)."

MODEL_COUNT="$(echo "$RESPONSE" | jq '.data | length')"
log "Fetched $MODEL_COUNT models"

# ---------------------------------------------------------------------------
# Save raw snapshot
# ---------------------------------------------------------------------------

if [[ "$SAVE" -eq 1 ]]; then
  if [[ -z "$JSON_OUT" ]]; then
    mkdir -p "$OUTPUT_DIR"
    JSON_OUT="$OUTPUT_DIR/models-$(date '+%Y%m%dT%H%M%S').json"
  else
    mkdir -p "$(dirname "$JSON_OUT")"
  fi
  echo "$RESPONSE" | jq '.' > "$JSON_OUT"
  log "Saved raw response to $JSON_OUT"
fi

if [[ "$RAW" -eq 1 ]]; then
  echo "$RESPONSE" | jq '.'
  exit 0
fi

# ---------------------------------------------------------------------------
# Summary table (id, context length, input/output $ per 1M tokens)
# ---------------------------------------------------------------------------

SEARCH_LOWER="$(echo "$SEARCH" | tr '[:upper:]' '[:lower:]')"

echo "$RESPONSE" | jq -r \
  --arg search "$SEARCH_LOWER" \
  --argjson limit "${LIMIT:-0}" '
  .data
  | (if $search != "" then map(select(.id | ascii_downcase | contains($search))) else . end)
  | sort_by(.id)
  | (if $limit > 0 then .[0:$limit] else . end)
  | ( ["MODEL ID", "CONTEXT", "INPUT $/1M", "OUTPUT $/1M"] | @tsv),
    (.[] | [
      .id,
      (.context_length // "-" | tostring),
      (if .pricing.prompt then (((.pricing.prompt | tonumber) * 1000000 * 100 | round) / 100 | tostring) else "-" end),
      (if .pricing.completion then (((.pricing.completion | tonumber) * 1000000 * 100 | round) / 100 | tostring) else "-" end)
    ] | @tsv)
' | column -t -s $'\t'

SHOWN_COUNT="$(echo "$RESPONSE" | jq \
  --arg search "$SEARCH_LOWER" \
  --argjson limit "${LIMIT:-0}" '
  .data
  | (if $search != "" then map(select(.id | ascii_downcase | contains($search))) else . end)
  | (if $limit > 0 then .[0:$limit] else . end)
  | length
')"

if [[ -n "$SEARCH" ]]; then
  log "Displayed $SHOWN_COUNT of $MODEL_COUNT models (filtered by '$SEARCH')"
else
  log "Displayed $SHOWN_COUNT of $MODEL_COUNT models"
fi
