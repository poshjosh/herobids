#!/usr/bin/env bash
# wait-for-build.sh — block until the GitHub "Build and Push Agent Image"
# workflow run for the given commit has COMPLETED successfully, then print the
# release SHA.
#
# The herobids agent image is built by CI (`.github/workflows/build-push-agent.yml`)
# and pushed to `ghcr.io/poshjosh/herobids-agent` so Nomad client nodes can pull
# it. `push.sh` builds the same image locally on the control plane, but the agent
# nodes only see the GHCR copy — so a deploy must not proceed until CI has
# finished pushing the current commit, or the nodes pull a stale (or missing)
# image.
#
# The SHA is NOT discovered here — it is already `origin/main` (the commit just
# pushed). This script only CONFIRMS the matching CI run reached terminal success.
# Matching by `head_sha` ensures we never accept a stale/other run on the same ref.
#
# Usage:
#   wait-for-build.sh [--sha <40-char SHA>]          # defaults to origin/main
#   wait-for-build.sh --repo poshjosh/herobids --sha <sha>
#
# Output: the release SHA is printed as the FINAL line on stdout (so a caller can
# capture it:  sha=$(wait-for-build.sh ... | tail -n1)).
set -euo pipefail

REPO=""
SHA=""

# Known-minimum CI duration before the first poll (see note below).
# Overridable: `waitBeforePollingSeconds=120 deploy.sh ...`
waitBeforePollingSeconds="${waitBeforePollingSeconds:-60}"
POLL_INTERVAL=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"; [[ -n "$REPO" ]] || { echo 'ERROR: --repo requires owner/repo' >&2; exit 2; }; shift 2;;
    --sha)
      SHA="${2:-}"; [[ -n "$SHA" ]] || { echo 'ERROR: --sha requires a value' >&2; exit 2; }; shift 2;;
    *)
      echo "ERROR: Unknown option: $1" >&2; exit 2;;
  esac
done

# Resolve the GitHub owner/repo from the origin remote (fall back to the known repo).
if [[ -z "$REPO" ]]; then
  REPO="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#(https://|git@)github.com[:/]?##; s#\.git$##')"
  [[ -n "$REPO" ]] || { echo 'ERROR: could not resolve GitHub repo from git remote; pass --repo owner/name' >&2; exit 2; }
fi

# Resolve the target commit (the one just pushed).
if [[ -z "$SHA" ]]; then
  SHA="$(git rev-parse origin/main 2>/dev/null || true)"
  [[ -n "$SHA" ]] || { echo 'ERROR: could not resolve origin/main; pass --sha <commit>' >&2; exit 2; }
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: --sha must be a 40-character commit SHA (got '$SHA')" >&2; exit 2; }

API_URL="https://api.github.com/repos/${REPO}/actions/runs"
WORKFLOWS_URL="https://api.github.com/repos/${REPO}/actions/workflows"
WORKFLOW_NAME="Build and Push Agent Image"

# A single acceptable curl base (no token for now; add -H "Authorization: Bearer
# $GH_TOKEN" later if rate limits ever bite).
curl_args=(curl -fsSL -H "Accept: application/vnd.github+json")

echo "CI build gate: repo=$REPO sha=$SHA workflow=\"$WORKFLOW_NAME\""

# Resolve the numeric id of the agent build-and-push workflow, so we only wait on
# THAT workflow's run — not any other workflow (e.g. "Slow Tests") that also has
# a run for the same head SHA. Mixing them up would let a fast sibling workflow's
# `completed/success` satisfy the gate before the agent image is actually pushed.
WORKFLOW_ID="$("${curl_args[@]}" "${WORKFLOWS_URL}" 2>/dev/null \
  | WORKFLOW_NAME="$WORKFLOW_NAME" python3 -c 'import json,sys,os; name=os.environ["WORKFLOW_NAME"]; [print(w["id"]) for w in json.load(sys.stdin).get("workflows",[]) if w.get("name")==name]' 2>/dev/null \
  | head -n1)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "ERROR: could not find workflow \"${WORKFLOW_NAME}\" in ${REPO}" >&2
  exit 2
fi

# Find the workflow run for this exact commit scoped to WORKFLOW_ID.
# The GitHub runs list endpoint does NOT reliably filter by workflow_id, so we
# fetch runs for the head SHA and select the one whose workflow_id matches, and
# where the run belongs to the intended workflow. Returns the run's database id,
# or empty if no matching run is listed yet.
find_run_id() {
  "${curl_args[@]}" "${API_URL}?head_sha=${SHA}&per_page=10" 2>/dev/null \
    | WORKFLOW_ID="$WORKFLOW_ID" python3 -c '
import json, sys, os
wf = os.environ["WORKFLOW_ID"]
for r in json.load(sys.stdin).get("workflow_runs", []):
    if str(r.get("workflow_id")) == wf:
        print(r["id"])
        break
' 2>/dev/null | head -n1
}

# ─── waitBeforePollingSeconds — why a named variable, not a bare `sleep 60` ────
# 1. It is the ONE place to tune when the build gets faster/slower (image size,
#    cache misses, runner load) — no hunting through the loop body.
# 2. It documents the assumption: CI empirically takes ~a minute, so polling
#    before this point is a pure waste of (rate-limited) API calls.
# 3. It is trivially overridable via `waitBeforePollingSeconds=90 deploy.sh ...`
#    without editing the script.
# ─────────────────────────────────────────────────────────────────────────────
# Progress is written to STDERR so it stays visible even when this script's
# stdout is captured by the caller (`sha=$(wait-for-build.sh | tail -n1)`).
# Only the final release SHA is written to stdout, on its own line.
# ─────────────────────────────────────────────────────────────────────────────
remaining=$waitBeforePollingSeconds
while [[ $remaining -gt 0 ]]; do
  printf 'waiting %ds for CI build-and-push of %s...\n' "$remaining" "$SHA" >&2
  sleep 5
  remaining=$((remaining - 5))
done

# ── Poll until the run completes; print progress on one overwriting line. ────
RUN_ID=""
for ((attempt = 1; attempt <= 90; attempt++)); do
  RUN_ID="$(find_run_id || true)"
  if [[ -n "$RUN_ID" ]]; then
    read -r status conclusion <<< "$("${curl_args[@]}" "${API_URL}/${RUN_ID}" 2>/dev/null \
      | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("status") or "", r.get("conclusion") or "")' 2>/dev/null)"

    if [[ "$status" == "completed" ]]; then
      if [[ "$conclusion" == "success" ]]; then
        printf '\nCI build-and-push succeeded: %s\n' "$SHA" >&2
        echo "$SHA"
        exit 0
      fi
      printf '\nCI build-and-push FAILED for %s (conclusion=%s)\n' "$SHA" "${conclusion:-none}" >&2
      exit 1
    fi
    printf 'polling GitHub Actions run %s (status=%s)...\r' "$RUN_ID" "${status:-queued}" >&2
  else
    printf 'polling GitHub Actions (run not listed yet, attempt %s)...\r' "$attempt" >&2
  fi
  sleep "$POLL_INTERVAL"
done

printf '\nERROR: timed out waiting for CI build of %s\n' "$SHA" >&2
exit 1