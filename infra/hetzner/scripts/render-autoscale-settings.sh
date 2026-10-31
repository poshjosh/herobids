#!/usr/bin/env bash
# render-autoscale-settings.sh — Render the non-secret demand-aware autoscale
# settings file from a KEY=VALUE input.
#
# One renderer for both paths, so they cannot drift:
#   - first boot: cloud-init writes the input and runs this from /opt/herobids;
#   - convergence: setup-control-plane.sh uploads the same input and
#     converge-control-plane.sh runs this on the existing control plane.
# The input comes from Terraform output autoscale_settings (single source:
# variables.tf defaults plus TF_VAR_* overrides). Nothing is sourced or eval'd.
#
# Input rules: blank lines are ignored; every other line must be KEY=VALUE.
# Only allowlisted keys are accepted, each exactly once, all required, with
# strict values. Any violation fails and leaves the output untouched.
#
# Output: /etc/herobids/autoscale-settings.env (0644). It is deliberately
# separate from the 0600 /etc/herobids/autoscale.env secrets file. The file is
# rewritten atomically and only when its content changes.
#
# --systemd-dir DIR: fail when a nomad-* unit or drop-in under DIR sets one of
# these keys with a different value. systemd lets EnvironmentFile= override
# Environment= for the same key, so an operator's stale Environment= value
# would otherwise be silently masked. Migrate it instead of guessing.
#
# --secrets-file FILE (default /etc/herobids/autoscale.env): fail when it sets
# one of these keys. Units load it after the settings file, so such a key would
# silently win; migrate it to the Terraform input instead.
#
# Usage:
#   render-autoscale-settings.sh --input FILE [--output FILE] [--systemd-dir DIR]
#                                [--secrets-file FILE]
#
# Exit: 0 written or unchanged; 1 invalid input, stale override or secrets
# collision; 2 usage.

set -euo pipefail

ALLOWED_KEYS=(
  NOMAD_AUTOSCALE_DEMAND_ENABLED
  NOMAD_SCALE_OUT_INCREMENT_MAX
  NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS
  NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS
  NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS
)

INPUT=""
OUTPUT="/etc/herobids/autoscale-settings.env"
SYSTEMD_DIR=""
SECRETS_FILE="/etc/herobids/autoscale.env"

usage() {
  echo "Usage: $0 --input FILE [--output FILE] [--systemd-dir DIR] [--secrets-file FILE]" >&2
  exit 2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) [[ $# -ge 2 ]] || usage; INPUT="$2"; shift 2 ;;
    --output) [[ $# -ge 2 ]] || usage; OUTPUT="$2"; shift 2 ;;
    --systemd-dir) [[ $# -ge 2 ]] || usage; SYSTEMD_DIR="$2"; shift 2 ;;
    --secrets-file) [[ $# -ge 2 ]] || usage; SECRETS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "${INPUT}" && -f "${INPUT}" ]] || { echo "ERROR: --input FILE is required and must exist" >&2; exit 2; }
[[ -n "${OUTPUT}" ]] || usage

is_allowed_key() {
  local k
  for k in "${ALLOWED_KEYS[@]}"; do
    [[ "$1" == "${k}" ]] && return 0
  done
  return 1
}

is_valid_value() {
  case "$1" in
    NOMAD_AUTOSCALE_DEMAND_ENABLED) [[ "$2" == "true" || "$2" == "false" ]] ;;
    # Batch cap per decision; matches the bound in scale-common.sh and variables.tf.
    NOMAD_SCALE_OUT_INCREMENT_MAX) [[ "$2" =~ ^[12]$ ]] ;;
    *) [[ "$2" =~ ^[1-9][0-9]{0,8}$ ]] ;;
  esac
}

# Reads a validated KEY from PARSED (KEY=VALUE lines).
value_of() {
  local line
  while IFS= read -r line; do
    if [[ "${line}" == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <<< "${PARSED}"
}

# The secrets file is loaded after the settings file, so a key there would
# silently win. Such keys must move to the Terraform input instead.
check_secrets_file() {
  local line key
  [[ -f "${SECRETS_FILE}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[1]}"
    if is_allowed_key "${key}"; then
      fail "${SECRETS_FILE} sets ${key}; migrate it to the Terraform autoscale_settings input and remove it from the secrets file, then converge again"
    fi
  done < "${SECRETS_FILE}"
  return 0
}

check_stale_overrides() {
  local dir="$1" file line rest key expected found re
  local -a files=()
  shopt -s nullglob
  files=("${dir}"/nomad-*.service "${dir}"/nomad-*.service.d/*.conf)
  shopt -u nullglob
  for file in "${files[@]+"${files[@]}"}"; do
    while IFS= read -r line || [[ -n "${line}" ]]; do
      [[ "${line}" =~ ^[[:space:]]*Environment=(.*)$ ]] || continue
      rest="${BASH_REMATCH[1]}"
      for key in "${ALLOWED_KEYS[@]}"; do
        re="(^|[[:space:]\"])${key}=([^[:space:]\"]*)"
        [[ "${rest}" =~ ${re} ]] || continue
        found="${BASH_REMATCH[2]}"
        expected="$(value_of "${key}")"
        if [[ "${found}" != "${expected}" ]]; then
          fail "stale override: ${file} sets ${key}=${found} but the settings input says ${expected}; remove the Environment= override and converge again"
        fi
      done
    done < "${file}"
  done
}

# ─── 1. Parse and validate the input ────────────────────────────────────────
PARSED=""
SEEN=" "
line_no=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  line_no=$((line_no + 1))
  [[ -z "${line}" ]] && continue
  if [[ ! "${line}" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    fail "input line ${line_no}: expected KEY=VALUE"
  fi
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  is_allowed_key "${key}" || fail "input line ${line_no}: unknown key '${key}'"
  [[ "${SEEN}" != *" ${key} "* ]] || fail "input line ${line_no}: duplicate key '${key}'"
  is_valid_value "${key}" "${value}" || fail "input line ${line_no}: invalid value for ${key}"
  SEEN="${SEEN}${key} "
  PARSED="${PARSED}${key}=${value}"$'\n'
done < "${INPUT}"

for key in "${ALLOWED_KEYS[@]}"; do
  [[ "${SEEN}" == *" ${key} "* ]] || fail "input is missing required key '${key}'"
done

# ─── 2. Render in allowlist order (deterministic bytes) ─────────────────────
RENDERED=""
for key in "${ALLOWED_KEYS[@]}"; do
  RENDERED="${RENDERED}${key}=$(value_of "${key}")"$'\n'
done

# ─── 3. Refuse to render over a stale override or a secrets collision ───────
check_secrets_file
if [[ -n "${SYSTEMD_DIR}" ]]; then
  check_stale_overrides "${SYSTEMD_DIR}"
fi

# ─── 4. Atomic write, only when content changes ─────────────────────────────
OUT_DIR="$(dirname "${OUTPUT}")"
mkdir -p "${OUT_DIR}"
TMP="$(mktemp "${OUT_DIR}/.autoscale-settings.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT
printf '%s' "${RENDERED}" > "${TMP}"
chmod 0644 "${TMP}"

if [[ -f "${OUTPUT}" ]]; then
  chmod 0644 "${OUTPUT}"
  if cmp -s "${TMP}" "${OUTPUT}"; then
    echo "autoscale settings unchanged: ${OUTPUT}"
    exit 0
  fi
fi

mv -f "${TMP}" "${OUTPUT}"
echo "autoscale settings written: ${OUTPUT}"
