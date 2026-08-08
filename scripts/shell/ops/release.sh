#!/usr/bin/env bash
# release.sh — Test, bump version, tag, and push a release.
#
# Workflow:
#   1. Verify on main branch (fail if not)
#   2. Validate version (fail-fast, before tests — if provided)
#   3. Ask commit scope (if version provided, before tests)
#   4. Run tests: run-all-tests.sh --e2e  [+ run-extra-tests.sh --all if --all]
#   5. If version provided: bump package.json + CHANGELOG.md, commit, push, tag, push tags.
#
# Usage:
#   scripts/shell/ops/release.sh <version>        # bump to version, run core tests
#   scripts/shell/ops/release.sh <version> --all  # bump to version, run ALL tests
#   scripts/shell/ops/release.sh --all            # run all tests, no version bump
#   scripts/shell/ops/release.sh                  # run core tests, no version bump
#
# Examples:
#   scripts/shell/ops/release.sh 0.1.2
#   scripts/shell/ops/release.sh v0.1.2 --all

set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TESTS_DIR="${ROOT}/scripts/shell/tests"

# ─── Colour helpers ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

log()    { echo -e "${CYAN}[release]${RESET} $*"; }
ok()     { echo -e "${GREEN}[release]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[release]${RESET} $*"; }
err()    { echo -e "${RED}[release]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

# ─── Parse arguments ─────────────────────────────────────────────────────────

VERSION=""
RUN_ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      RUN_ALL=true
      shift
      ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      err "Unknown flag: $1  (use --help for usage)"
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        err "Unexpected extra argument: $1 (already have version '$VERSION')"
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

# ─── Pre-flight: must be on main ─────────────────────────────────────────────

header "Pre-flight"

CURRENT_BRANCH=$(git -C "$ROOT" branch --show-current 2>/dev/null || echo "unknown")
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  err "Not on main branch (current: $CURRENT_BRANCH)."
  err "Release must be done from main. Switch with: git checkout main"
  exit 1
fi
ok "On main branch"

# Pull latest to avoid push conflicts
log "Pulling latest from origin/main…"
if ! git -C "$ROOT" pull --ff-only origin main 2>&1; then
  err "Failed to pull latest from origin/main. Resolve conflicts or stash changes first."
  exit 1
fi
ok "Branch is up to date with origin/main"

# ─── Version validation (fail-fast, before expensive tests) ──────────────────

if [[ -n "$VERSION" ]]; then
  header "Version validation"

  # Strip leading 'v' / 'V' if present
  RAW="${VERSION}"
  VERSION="${VERSION#v}"
  VERSION="${VERSION#V}"

  # Validate semver: X.Y.Z with optional pre-release/build metadata
  if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
    err "Invalid version string: '${RAW}'"
    err "Expected semver format: X.Y.Z  (e.g. 0.1.2, v1.0.0, 2.3.4-beta.1)"
    exit 1
  fi
  ok "Version validated: ${VERSION}"

  # Check tag doesn't already exist
  TAG="v${VERSION}"
  if git -C "$ROOT" tag -l "$TAG" | grep -q "$TAG"; then
    err "Tag ${TAG} already exists."
    err "Delete it first (git tag -d ${TAG} && git push origin :refs/tags/${TAG}) or choose a different version."
    exit 1
  fi
  ok "Tag ${TAG} is available"

  # Check package.json version isn't already set to this
  PKG_JSON="${ROOT}/package.json"
  CURRENT_VERSION=$(jq -r '.version' "$PKG_JSON")
  if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
    err "package.json version is already ${VERSION}. Is this version already released?"
    exit 1
  fi

  # ─── Commit scope: ask the user (before tests, so they can walk away) ──────

  echo ""
  log "About to bump version to ${TAG} and commit changes."
  log ""

  UNSTAGED=$(git -C "$ROOT" status --short 2>/dev/null || echo "")
  if [[ -n "$UNSTAGED" ]]; then
    warn "Uncommitted changes detected:"
    echo "$UNSTAGED" | while read -r line; do echo "  $line"; done
    echo ""
  fi

  echo -n "Commit ALL unstaged files or only CHANGELOG.md + package.json? [A]ll / [o]nly bump files: "
  read -r COMMIT_CHOICE

  case "${COMMIT_CHOICE,,}" in
    a|all)
      COMMIT_ALL=true
      log "Will commit all unstaged files."
      ;;
    o|only|"")
      COMMIT_ALL=false
      log "Will commit only CHANGELOG.md + package.json."
      ;;
    *)
      err "Invalid choice: '$COMMIT_CHOICE'. Enter 'a' or 'o'."
      exit 1
      ;;
  esac
else
  TAG=""
fi

# ─── Run tests ───────────────────────────────────────────────────────────────

header "Tests"

log "Running core tests: run-all-tests.sh --e2e"
if ! bash "${TESTS_DIR}/run-all-tests.sh" --e2e; then
  err "Core tests FAILED. Fix failures before releasing."
  exit 1
fi
ok "Core tests passed"

if $RUN_ALL; then
  log "Running extra tests: run-extra-tests.sh --all"
  if ! bash "${TESTS_DIR}/run-extra-tests.sh" --all; then
    err "Extra tests FAILED. Fix failures before releasing."
    exit 1
  fi
  ok "Extra tests passed"
fi

# ─── Version bump (only if version provided) ─────────────────────────────────

if [[ -z "$VERSION" ]]; then
  header "Done"
  ok "All tests passed. No version provided — skipping bump/tag/push."
  ok "To release, re-run with a version: scripts/shell/ops/release.sh <version> [--all]"
  exit 0
fi

header "Version bump → ${TAG}"

log "Bumping package.json: ${CURRENT_VERSION} → ${VERSION}"
jq --arg v "$VERSION" '.version = $v' "$PKG_JSON" > "${PKG_JSON}.tmp" && mv "${PKG_JSON}.tmp" "$PKG_JSON"
ok "package.json updated"

# ─── Update CHANGELOG.md ─────────────────────────────────────────────────────

CHANGELOG="${ROOT}/CHANGELOG.md"
if [[ ! -f "$CHANGELOG" ]]; then
  err "CHANGELOG.md not found at ${CHANGELOG}"
  exit 1
fi

TODAY=$(date +%Y-%m-%d)
NEW_ENTRY="## v${VERSION} - ${TODAY}"

if ! grep -q '^## \[Unreleased\]' "$CHANGELOG"; then
  err "CHANGELOG.md does not contain a '## [Unreleased]' section."
  err "Add one before running this script."
  exit 1
fi

# Insert new entry after the [Unreleased] line (with a blank line spacer)
# Using sed: after the line matching '## [Unreleased]', append a blank line then the new entry
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS sed
  sed -i '' "/^## \[Unreleased\]/a\\
\\
${NEW_ENTRY}" "$CHANGELOG"
else
  # GNU sed
  sed -i "/^## \[Unreleased\]/a \\\n${NEW_ENTRY}" "$CHANGELOG"
fi

ok "CHANGELOG.md updated with: ${NEW_ENTRY}"

# ─── Commit ──────────────────────────────────────────────────────────────────

cd "$ROOT"

if $COMMIT_ALL; then
  git add -A
else
  git add package.json CHANGELOG.md
fi

# Check there's something to commit
if git diff --cached --quiet; then
  err "No changes staged for commit. The version may already be set."
  exit 1
fi

COMMIT_MSG="Bump to ${TAG}"
log "Committing: ${COMMIT_MSG}"
git commit -m "$COMMIT_MSG"
ok "Committed: ${COMMIT_MSG}"

# ─── Push ────────────────────────────────────────────────────────────────────

log "Pushing to origin/main…"
git push origin main
ok "Pushed to origin/main"

# ─── Tag and push tags ───────────────────────────────────────────────────────

log "Tagging: ${TAG}"
git tag "$TAG"
ok "Tagged: ${TAG}"

log "Pushing tags…"
git push --tags
ok "Tags pushed"

# ─── Done ────────────────────────────────────────────────────────────────────

header "Released ${TAG}"
ok "Version ${TAG} has been released successfully."
ok "  Commit: $(git rev-parse --short HEAD)"
ok "  Tag:    ${TAG}"
