#!/usr/bin/env bash
# test-openrouter-latest-tag.sh — Verify whether OpenRouter's /v1/models
# endpoint returns :latest tag variants alongside individual model versions.
#
# Background:
#   OpenRouter supports a :latest alias at the /chat/completions level
#   (e.g. openai/gpt-5:latest resolves to the newest version server-side).
#   The question is whether /v1/models also lists :latest entries so that
#   downstream catalogs (our dynamic model picker) can surface them.
#
# Usage:
#   scripts/shell/ops/test-openrouter-latest-tag.sh
#   scripts/shell/ops/test-openrouter-latest-tag.sh --verbose
#   LLM_API_KEY_OPENROUTER=sk-or-... scripts/shell/ops/test-openrouter-latest-tag.sh
#
# Setup:
#   Set LLM_API_KEY_OPENROUTER in your environment, or in scripts/.env:
#     echo 'LLM_API_KEY_OPENROUTER=sk-or-...' >> scripts/.env
#   chmod +x scripts/shell/ops/test-openrouter-latest-tag.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/scripts/.env"

# ---------------------------------------------------------------------------
# Load .env if present (for LLM_API_KEY_OPENROUTER)
# ---------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
    --help|-h)
      echo "Usage: $0 [--verbose|-v] [--help|-h]"
      echo ""
      echo "Fetches OpenRouter /v1/models and checks for :latest tag support."
      echo ""
      echo "Requires LLM_API_KEY_OPENROUTER in environment or scripts/.env"
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate API key
# ---------------------------------------------------------------------------
API_KEY="${LLM_API_KEY_OPENROUTER:-}"
if [[ -z "$API_KEY" ]]; then
  echo "ERROR: LLM_API_KEY_OPENROUTER is not set."
  echo "  Set it in your environment or in scripts/.env:"
  echo "    echo 'LLM_API_KEY_OPENROUTER=sk-or-...' >> scripts/.env"
  exit 1
fi

OPENROUTER_MODELS_URL="https://openrouter.ai/api/v1/models"

# ---------------------------------------------------------------------------
# Fetch model catalog
# ---------------------------------------------------------------------------
echo "==> Fetching $OPENROUTER_MODELS_URL ..."
RESPONSE=$(curl -sS --max-time 15 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Accept: application/json" \
  "$OPENROUTER_MODELS_URL" 2>&1) || {
  echo "ERROR: curl failed: $RESPONSE"
  exit 1
}

# Check for non-JSON response (e.g. HTML error page)
if ! echo "$RESPONSE" | python3 -m json.tool > /dev/null 2>&1; then
  echo "ERROR: response is not valid JSON. First 300 chars:"
  echo "$RESPONSE" | head -c 300
  echo ""
  exit 1
fi

# Extract model IDs (top-level .data[].id)
MODEL_IDS=$(echo "$RESPONSE" | python3 -c "
import json, sys
payload = json.load(sys.stdin)
data = payload.get('data', [])
ids = [m['id'] for m in data if isinstance(m, dict) and 'id' in m]
for mid in sorted(set(ids)):
    print(mid)
")

TOTAL=$(echo "$MODEL_IDS" | wc -l | tr -d ' ')
echo "==> Total unique model IDs returned: $TOTAL"

# ---------------------------------------------------------------------------
# Assertion 1: Does OpenRouter include :latest variants?
# ---------------------------------------------------------------------------
LATEST_IDS=$(echo "$MODEL_IDS" | grep ':latest$' || true)
LATEST_COUNT=$(echo "$LATEST_IDS" | grep -c . || echo 0)

echo ""
echo "============================================================"
echo "  ASSERTION: OpenRouter /v1/models includes :latest variants"
echo "============================================================"
if [[ -n "$LATEST_IDS" ]]; then
  echo "  RESULT: TRUE — $LATEST_COUNT model(s) with :latest found"
  if $VERBOSE; then
    echo "$LATEST_IDS" | sed 's/^/    /'
  fi
else
  echo "  RESULT: FALSE — no :latest entries returned"
fi

# ---------------------------------------------------------------------------
# Assertion 2: Can we derive :latest families from the versioned model list?
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  DERIVATION: :latest families extractable from versioned IDs"
echo "============================================================"

FAMILIES=$(echo "$MODEL_IDS" | python3 -c "
import sys, re, json
from collections import defaultdict

ids = [line.strip() for line in sys.stdin if line.strip()]

# Skip IDs that are already :latest variants
ids = [i for i in ids if not i.endswith(':latest')]

# Group by family: strip trailing -<version> where version is digits[.digits]*
# Examples:
#   openai/gpt-5.5       → family=openai/gpt-5
#   anthropic/claude-sonnet-4.6 → family=anthropic/claude-sonnet-4
#   deepseek/deepseek-v4-pro    → family=deepseek/deepseek-v4  (no numeric version → skip)
families = defaultdict(list)
for mid in sorted(ids):
    m = re.match(r'^(.+)-(\d+(?:\.\d+)*)$', mid)
    if not m:
        continue
    family = m.group(1)
    version = m.group(2)
    families[family].append((version, mid))

# Only keep families with ≥2 entries (pointless to :latest a single version)
families = {k: v for k, v in families.items() if len(v) >= 2}

if not families:
    print('NONE — no multi-version families found')
else:
    print(f'{len(families)} families found that could support :latest:')
    print()
    for family in sorted(families):
        members = families[family]
        # Sort by version desc (simple numeric compare on split parts)
        def version_key(item):
            parts = item[0].split('.')
            return tuple(int(p) for p in parts)
        members_sorted = sorted(members, key=version_key, reverse=True)
        latest_model = members_sorted[0][1]
        print(f'  {family}:latest')
        print(f'    → would resolve to {latest_model}')
        if len(members_sorted) > 1:
            others = [m[1] for m in members_sorted[1:]]
            print(f'    → other versions: {', '.join(others)}')
")

echo ""
echo "============================================================"
echo "  SUMMARY"
echo "============================================================"
echo "  API returns :latest natively:  ${LATEST_COUNT:-0} entries"

# Count derivable families
DERIVABLE=$(echo "$FAMILIES" | grep -c 'would resolve to' || echo 0)
echo "  Derivable :latest families:    ${DERIVABLE}"
echo ""
if [[ "${LATEST_COUNT:-0}" -eq 0 ]]; then
  echo "  HeroBids must derive :latest variants client-side"
  echo "  (see apps/api/src/llm-model-catalog.ts — deriveLatestVariants)"
else
  echo "  :latest variants are already in the API response — no derivation needed"
fi
