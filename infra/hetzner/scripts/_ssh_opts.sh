# _ssh_opts.sh — Shared SSH options and environment helpers for Herobids deploy scripts.
#
# Source this file in deploy scripts to get:
#   SSH_OPTS              SSH options string for use with ssh/scp commands.
#   HEROBIDS_SSH_KEY      Exported for child scripts to inherit.
#   HEROBIDS_ENV          Deployment environment: staging | production (default: production).
#   COMPOSE_OVERLAY       Compose overlay filename for the current environment.
#   COMPOSE_OVERLAY_PATH  Full server-side path to the compose overlay.
#   compose_files()       Prints compose file arguments for docker compose commands.
#
# Environment variables:
#   HEROBIDS_SSH_KEY      Override path to SSH private key (optional).
#                          If not set, auto-detected from terraform.tfvars.
#   HEROBIDS_ENV          Deployment environment: staging | production (default: production).
#
# Scripts that accept --env can call parse_env_flag() to set HEROBIDS_ENV.

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

# ─── Environment selection ────────────────────────────────────────────────

HEROBIDS_ENV="${HEROBIDS_ENV:-production}"

case "${HEROBIDS_ENV}" in
  staging)    COMPOSE_OVERLAY="docker-compose.staging.yaml" ;;
  production) COMPOSE_OVERLAY="docker-compose.prod.yaml" ;;
  *)          echo "ERROR: Unknown HEROBIDS_ENV=${HEROBIDS_ENV}. Must be staging or production." >&2; exit 1 ;;
esac

COMPOSE_OVERLAY_PATH="/opt/herobids/${COMPOSE_OVERLAY}"

# compose_files — prints the compose file arguments for docker compose commands.
# Usage: docker compose $(compose_files) up -d
compose_files() {
  echo "-f docker-compose.yaml -f ${COMPOSE_OVERLAY_PATH}"
}

export HEROBIDS_ENV COMPOSE_OVERLAY COMPOSE_OVERLAY_PATH

# parse_env_flag — parse --env <name> from the current argument list.
# Call this after sourcing _ssh_opts.sh, before your own arg parsing.
# Usage: parse_env_flag "$@"; shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true
# Sets HEROBIDS_ENV and HEROBIDS_ENV_SHIFT (number of args consumed).
parse_env_flag() {
  HEROBIDS_ENV_SHIFT=0
  local _args=("$@")
  local _i=0
  while [[ $_i -lt ${#_args[@]} ]]; do
    case "${_args[$_i]}" in
      --env)
        _i=$((_i + 1))
        if [[ $_i -ge ${#_args[@]} || -z "${_args[$_i]}" ]]; then
          echo "ERROR: --env requires a value (staging or production)." >&2
          exit 1
        fi
        HEROBIDS_ENV="${_args[$_i]}"
        _i=$((_i + 1))
        ;;
      --env=*)
        HEROBIDS_ENV="${_args[$_i]#*=}"
        _i=$((_i + 1))
        ;;
      *)
        break
        ;;
    esac
  done
  HEROBIDS_ENV_SHIFT=$_i

  # Re-derive compose overlay from the (possibly updated) HEROBIDS_ENV
  case "${HEROBIDS_ENV}" in
    staging)    COMPOSE_OVERLAY="docker-compose.staging.yaml" ;;
    production) COMPOSE_OVERLAY="docker-compose.prod.yaml" ;;
    *)          echo "ERROR: Unknown HEROBIDS_ENV=${HEROBIDS_ENV}. Must be staging or production." >&2; exit 1 ;;
  esac
  COMPOSE_OVERLAY_PATH="/opt/herobids/${COMPOSE_OVERLAY}"
  export HEROBIDS_ENV COMPOSE_OVERLAY COMPOSE_OVERLAY_PATH
}

# Clean up internal variables
unset _HEROBIDS_SSH_KEY _TFVARS _PUB_KEY
