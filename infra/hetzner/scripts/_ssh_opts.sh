# _ssh_opts.sh — Shared SSH options for Herobids deploy scripts.
#
# Source this file in deploy scripts to get SSH_OPTS with automatic
# SSH key detection from terraform.tfvars.
#
# Environment variables:
#   HEROBIDS_SSH_KEY   Override path to SSH private key (optional).
#                       If not set, auto-detected from terraform.tfvars.
#
# Outputs:
#   SSH_OPTS           SSH options string for use with ssh/scp commands.
#   HEROBIDS_SSH_KEY   Exported for child scripts to inherit.

# ─── Resolve the key path ─────────────────────────────────────────────────

_HEROBIDS_SSH_KEY="${HEROBIDS_SSH_KEY:-}"

if [[ -z "${_HEROBIDS_SSH_KEY}" ]]; then
  # Derive from terraform.tfvars: read ssh_public_key_path, strip .pub
  _TFVARS="$(dirname "$(dirname "${BASH_SOURCE[0]}")")/terraform.tfvars"
  if [[ -f "${_TFVARS}" ]]; then
    _PUB_KEY=$(grep -o 'ssh_public_key_path\s*=\s*"[^"]*"' "${_TFVARS}" 2>/dev/null \
      | cut -d'"' -f2 | sed 's|^~|'"${HOME}"'|')
    if [[ -n "${_PUB_KEY}" && -f "${_PUB_KEY}" ]]; then
      _HEROBIDS_SSH_KEY="${_PUB_KEY%.pub}"
    fi
  fi
fi

# ─── Build SSH_OPTS ──────────────────────────────────────────────────────

SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
if [[ -n "${_HEROBIDS_SSH_KEY}" && -f "${_HEROBIDS_SSH_KEY}" ]]; then
  SSH_OPTS="${SSH_OPTS} -i ${_HEROBIDS_SSH_KEY}"
fi

export HEROBIDS_SSH_KEY="${_HEROBIDS_SSH_KEY}"

# Clean up internal variables
unset _HEROBIDS_SSH_KEY _TFVARS _PUB_KEY
