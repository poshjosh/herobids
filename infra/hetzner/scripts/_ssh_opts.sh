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
#                          If not set, auto-detected from terraform.tfvars,
#                          falling back to ${HEROBIDS_ENV}.tfvars.
#   HEROBIDS_ENV          Deployment environment: staging | production (default: production).
#
# Scripts that accept --env can call parse_env_flag() to set HEROBIDS_ENV.
# When using --env, it MUST be the first argument (before any other flags):
#   Correct:   script.sh --env staging --skip-deploy
#   Incorrect: script.sh --skip-deploy --env staging

# ─── Terraform directory ─────────────────────────────────────────────────

: "${TF_DIR:="$(dirname "$(dirname "${BASH_SOURCE[0]}")")"}"
export TF_DIR

# Capture whether the user explicitly set HEROBIDS_SSH_KEY before auto-detection.
# If set, auto-detection is skipped entirely — the user's key always wins.
_HEROBIDS_SSH_KEY_USER_SET="${HEROBIDS_SSH_KEY:+1}"

# resolve_ssh_key — discover the SSH private key with environment-aware fallback.
# Precedence:
#   1. HEROBIDS_SSH_KEY env var explicitly set by user (captured at source time)
#   2. ssh_public_key_path from terraform.tfvars
#   3. ssh_public_key_path from ${HEROBIDS_ENV}.tfvars (e.g., staging.tfvars)
# Sets global _HEROBIDS_SSH_KEY and rebuilds SSH_OPTS.
# Safe to call multiple times — re-resolves from tfvars on each call
# unless the user explicitly provided HEROBIDS_SSH_KEY.
resolve_ssh_key() {
  local _HEROBIDS_SSH_KEY
  # 1. User-provided override — always wins, skip all discovery
  if [[ "${_HEROBIDS_SSH_KEY_USER_SET:-}" == "1" ]]; then
    _HEROBIDS_SSH_KEY="${HEROBIDS_SSH_KEY:-}"
    SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
    if [[ -n "${_HEROBIDS_SSH_KEY}" && -f "${_HEROBIDS_SSH_KEY}" ]]; then
      SSH_OPTS="${SSH_OPTS} -i ${_HEROBIDS_SSH_KEY}"
    fi
    export HEROBIDS_SSH_KEY="${_HEROBIDS_SSH_KEY}"
    return
  fi

  # Fresh discovery from tfvars based on current HEROBIDS_ENV
  _HEROBIDS_SSH_KEY=""

  # 2. Try terraform.tfvars
  local _TFVARS="${TF_DIR}/terraform.tfvars"
  if [[ -f "${_TFVARS}" ]]; then
    local _PUB_KEY
    _PUB_KEY=$(grep -o 'ssh_public_key_path\s*=\s*"[^"]*"' "${_TFVARS}" 2>/dev/null \
      | cut -d'"' -f2 | sed 's|^~|'"${HOME}"'|')
    if [[ -n "${_PUB_KEY}" && -f "${_PUB_KEY}" ]]; then
      _HEROBIDS_SSH_KEY="${_PUB_KEY%.pub}"
    fi
  fi

  # 3. Fallback: environment-specific tfvars (e.g., staging.tfvars)
  if [[ -z "${_HEROBIDS_SSH_KEY}" ]] || [[ ! -f "${_HEROBIDS_SSH_KEY}" ]]; then
    local _ENV_TFVARS="${TF_DIR}/${HEROBIDS_ENV}.tfvars"
    if [[ -f "${_ENV_TFVARS}" ]]; then
      local _PUB_KEY
      _PUB_KEY=$(grep -o 'ssh_public_key_path\s*=\s*"[^"]*"' "${_ENV_TFVARS}" 2>/dev/null \
        | cut -d'"' -f2 | sed 's|^~|'"${HOME}"'|')
      if [[ -n "${_PUB_KEY}" && -f "${_PUB_KEY}" ]]; then
        _HEROBIDS_SSH_KEY="${_PUB_KEY%.pub}"
      fi
    fi
  fi

  # Rebuild SSH_OPTS from the resolved key
  SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
  if [[ -n "${_HEROBIDS_SSH_KEY}" && -f "${_HEROBIDS_SSH_KEY}" ]]; then
    SSH_OPTS="${SSH_OPTS} -i ${_HEROBIDS_SSH_KEY}"
  fi

  if [[ -z "${_HEROBIDS_SSH_KEY}" || ! -f "${_HEROBIDS_SSH_KEY}" ]]; then
    echo "WARNING: No SSH key found. Tried HEROBIDS_SSH_KEY, terraform.tfvars, and ${HEROBIDS_ENV}.tfvars." >&2
    echo "WARNING: SSH connections may fail. Set HEROBIDS_SSH_KEY or ensure ssh_public_key_path is set in a tfvars file." >&2
  fi

  export HEROBIDS_SSH_KEY="${_HEROBIDS_SSH_KEY}"
}

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

# Resolve SSH key now that HEROBIDS_ENV is known
resolve_ssh_key

# parse_env_flag — parse --env <name> from the current argument list.
# Call this after sourcing _ssh_opts.sh, before your own arg parsing.
#
# IMPORTANT: --env must appear BEFORE any other flags (e.g., --skip-deploy, --yes).
# parse_env_flag stops scanning at the first non---env argument.
# Correct:   script.sh --env staging --skip-deploy
# Incorrect: script.sh --skip-deploy --env staging
#
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

  # Re-resolve SSH key for the new environment
  resolve_ssh_key
}

# terraform_output — workspace-aware terraform output wrapper.
# Usage: terraform_output [-raw] <output_name>
# Runs in a subshell from TF_DIR, selects the correct workspace first.
# Prints the output value to stdout.
# Exits with a clear error if the workspace doesn't exist yet.
terraform_output() {
  (
    cd "${TF_DIR}" || { echo "ERROR: Cannot access terraform directory ${TF_DIR}" >&2; exit 1; }
    terraform workspace select "${HEROBIDS_ENV}" >/dev/null 2>&1 || {
      echo "ERROR: Terraform workspace '${HEROBIDS_ENV}' does not exist." >&2
      echo "Run provision.sh --env ${HEROBIDS_ENV} first to create it." >&2
      exit 1
    }
    terraform output "$@"
  )
}

# resolve_ssh_key is kept defined — parse_env_flag() calls it
# when --env overrides HEROBIDS_ENV at runtime.
# Local variables inside the function are already scoped with `local`.
