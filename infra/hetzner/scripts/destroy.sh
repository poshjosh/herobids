#!/usr/bin/env bash
# destroy.sh — Terraform teardown for a Herobids Hetzner environment.
#
# Tears down an entire environment (control-plane server, agent nodes,
# private network, firewall, SSH key) via `terraform destroy`, scoped to the
# selected workspace's isolated S3 state. This is the inverse of provision.sh.
#
# ⚠️  DESTRUCTIVE & HARD TO REVERSE. This permanently deletes servers and their
#     volumes (DB, Redis, uploaded state). It does NOT touch DNS records or the
#     S3 state bucket itself — only the infrastructure tracked in this workspace.
#
# prevent_destroy handling:
#   `hcloud_server.default` (the control-plane server) has a hardcoded
#   `prevent_destroy = true` lifecycle guard in main.tf. Terraform evaluates this
#   statically, so a plain `terraform destroy` fails on that resource. This script
#   lifts the guard for the duration of the destroy using a temporary Terraform
#   override file (`zz_destroy_override.tf`), then removes it on exit — main.tf is
#   never modified. Override files are a documented Terraform merge mechanism.
#
# Usage:
#   infra/hetzner/scripts/destroy.sh --env <staging|production> [--var-file <path>] \
#     [--backend-env-file <path>] [--yes] [--i-understand-this-is-production]
#
#   infra/hetzner/scripts/destroy.sh --env staging --var-file staging.tfvars --backend-env-file .env.backend
#
# Environment:
#   HEROBIDS_ENV   Deployment environment. There is NO default for destroy —
#                  --env (or HEROBIDS_ENV) MUST be set explicitly.
#
# Requires:
#   - terraform (>= 1.0)
#   - S3 backend credentials (via --backend-env-file, shell env, or .envrc):
#       TF_BACKEND_BUCKET, TF_BACKEND_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   - HCLOUD_TOKEN in the environment or the var-file

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Track whether --env was explicitly provided (destroy has no safe default).
# --help/-h always short-circuits the requirement so usage is always reachable.
_ENV_EXPLICIT=0
_WANTS_HELP=0
for _a in "$@"; do
  case "${_a}" in
    --env|--env=*) _ENV_EXPLICIT=1 ;;
    --help|-h)     _WANTS_HELP=1 ;;
  esac
done
if [[ "${_WANTS_HELP}" -eq 0 && -z "${HEROBIDS_ENV:-}" && "${_ENV_EXPLICIT}" -eq 0 ]]; then
  echo "ERROR: destroy requires an explicit environment." >&2
  echo "  Pass --env staging (or --env production), or set HEROBIDS_ENV." >&2
  echo "  There is no default — this guards against tearing down the wrong environment." >&2
  exit 1
fi

# Source _ssh_opts.sh for HEROBIDS_ENV and parse_env_flag.
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse arguments ─────────────────────────────────────────────────────────

VAR_FILE=""
TF_CLI_ARGS=""
AUTO_APPROVE=false
PROD_ACK=false
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${TF_DIR}/.env.backend}"

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file)
      VAR_FILE="${2:-}"
      if [[ -z "${VAR_FILE}" ]]; then
        echo "ERROR: --var-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"
      if [[ -z "${BACKEND_ENV_FILE}" ]]; then
        echo "ERROR: --backend-env-file requires a path argument." >&2
        exit 1
      fi
      shift 2
      ;;
    --yes|--auto-approve)
      AUTO_APPROVE=true
      shift
      ;;
    --i-understand-this-is-production)
      PROD_ACK=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 --env <staging|production> [--var-file <path>] [--backend-env-file <path>] [--yes] [--i-understand-this-is-production]" >&2
      echo "" >&2
      echo "Tears down an entire environment via terraform destroy (scoped to its workspace)." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>                        Target environment: staging or production (REQUIRED)." >&2
      echo "  --var-file <path>                   Path to the environment's tfvars file." >&2
      echo "  --backend-env-file <path>           Path to env file with S3 backend credentials" >&2
      echo "                                      (TF_BACKEND_BUCKET, AWS_ACCESS_KEY_ID, etc.)." >&2
      echo "                                      Sourced before terraform init. Defaults to .env.backend." >&2
      echo "  --yes, --auto-approve               Skip the interactive confirmation prompt (CI/CD)." >&2
      echo "  --i-understand-this-is-production   Required to destroy the production environment." >&2
      echo "" >&2
      echo "⚠️  This permanently deletes servers and their volumes (DB, Redis, state)." >&2
      echo "    It does NOT delete DNS records or the S3 state bucket." >&2
      echo "" >&2
      echo "Examples:" >&2
      echo "  $0 --env staging --var-file staging.tfvars --backend-env-file .env.backend" >&2
      echo "  $0 --env staging --var-file staging.tfvars --yes  # CI/CD mode" >&2
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      shift
      ;;
  esac
done

cd "${TF_DIR}"

# Verify terraform is installed
if ! command -v terraform &>/dev/null; then
  echo "ERROR: terraform not found in PATH. Install terraform >= 1.0." >&2
  echo "  macOS: brew install terraform" >&2
  echo "  Linux: https://developer.hashicorp.com/terraform/install" >&2
  exit 1
fi

# ─── Production gate ─────────────────────────────────────────────────────────

if [[ "${HEROBIDS_ENV}" == "production" && "${PROD_ACK}" != "true" ]]; then
  echo "" >&2
  printf "\033[1;31mERROR: Refusing to destroy PRODUCTION without --i-understand-this-is-production.\033[0m\n" >&2
  echo "  Destroying production deletes live user data and trading state." >&2
  echo "  If you are certain, re-run with --i-understand-this-is-production." >&2
  exit 1
fi

# ─── Resolve var-file ────────────────────────────────────────────────────────

if [[ -n "${VAR_FILE}" ]]; then
  if [[ "${VAR_FILE}" != /* ]]; then
    VAR_FILE="${TF_DIR}/${VAR_FILE}"
  fi
  if [[ ! -f "${VAR_FILE}" ]]; then
    echo "ERROR: --var-file '${VAR_FILE}' does not exist." >&2
    exit 1
  fi
  TF_CLI_ARGS="-var-file=${VAR_FILE}"
  echo "==> Using var-file: ${VAR_FILE}"
fi

# ─── Source backend env file (must happen before any terraform command) ───────

if [[ -n "${BACKEND_ENV_FILE}" ]]; then
  if [[ "${BACKEND_ENV_FILE}" != /* ]]; then
    BACKEND_ENV_FILE="${TF_DIR}/${BACKEND_ENV_FILE}"
  fi
  if [[ ! -f "${BACKEND_ENV_FILE}" ]]; then
    echo "ERROR: --backend-env-file '${BACKEND_ENV_FILE}' does not exist." >&2
    echo "  Provide S3 backend credentials via --backend-env-file, shell env, or .envrc." >&2
    exit 1
  fi
  echo "==> Sourcing backend env file: ${BACKEND_ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${BACKEND_ENV_FILE}"
  set +a
fi

# ─── Terraform backend init ──────────────────────────────────────────────────

TF_BACKEND_BUCKET="${TF_BACKEND_BUCKET:-}"
TF_BACKEND_REGION="${TF_BACKEND_REGION:-us-east-1}"
TF_BACKEND_DYNAMODB_TABLE="${TF_BACKEND_DYNAMODB_TABLE:-}"

if [[ -z "${TF_BACKEND_BUCKET}" ]]; then
  echo "ERROR: TF_BACKEND_BUCKET is not set." >&2
  echo "The S3 remote backend requires:" >&2
  echo "  TF_BACKEND_BUCKET      — S3 bucket name" >&2
  echo "  TF_BACKEND_REGION      — AWS region (default: us-east-1)" >&2
  echo "  AWS_ACCESS_KEY_ID      — AWS credentials" >&2
  echo "  AWS_SECRET_ACCESS_KEY  — AWS credentials" >&2
  echo "" >&2
  echo "Provide them via --backend-env-file .env.backend, shell env, or .envrc." >&2
  exit 1
fi

echo "==> [${HEROBIDS_ENV}] Running terraform init..."

INIT_ARGS=(-input=false -reconfigure \
  "-backend-config=bucket=${TF_BACKEND_BUCKET}" \
  "-backend-config=key=herobids/${HEROBIDS_ENV}/terraform.tfstate" \
  "-backend-config=region=${TF_BACKEND_REGION}" \
)

if [[ -n "${TF_BACKEND_DYNAMODB_TABLE}" ]]; then
  INIT_ARGS+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
fi

terraform init "${INIT_ARGS[@]}"

# ─── Terraform workspace ─────────────────────────────────────────────────────

echo "==> Selecting terraform workspace: ${HEROBIDS_ENV}"
terraform workspace select "${HEROBIDS_ENV}" 2>/dev/null || {
  echo "ERROR: Terraform workspace '${HEROBIDS_ENV}' does not exist." >&2
  echo "  Nothing to destroy for this environment." >&2
  exit 1
}

# Hard guard: the active workspace MUST match the requested environment.
# This is the last line of defence against destroying the wrong state.
ACTIVE_WS="$(terraform workspace show)"
if [[ "${ACTIVE_WS}" != "${HEROBIDS_ENV}" ]]; then
  echo "ERROR: Active workspace '${ACTIVE_WS}' does not match --env '${HEROBIDS_ENV}'." >&2
  echo "  Aborting to avoid destroying the wrong environment." >&2
  exit 1
fi

# ─── Lift prevent_destroy via a temporary override file ──────────────────────
#
# hcloud_server.default has a hardcoded `prevent_destroy = true` in main.tf.
# Terraform merges *_override.tf files over the base config, letting us set
# prevent_destroy = false for this run without editing main.tf. The override is
# removed on exit (success, failure, or Ctrl-C) so the guard is always restored.

OVERRIDE_FILE="${TF_DIR}/zz_destroy_override.tf"

cleanup_override() {
  if [[ -f "${OVERRIDE_FILE}" ]]; then
    rm -f "${OVERRIDE_FILE}"
    echo "==> Removed temporary prevent_destroy override."
  fi
}
trap cleanup_override EXIT INT TERM

cat > "${OVERRIDE_FILE}" <<'EOF'
# TEMPORARY — generated by destroy.sh to lift the prevent_destroy guard on the
# control-plane server for a single teardown run. This file is auto-removed on
# exit. If you see it lingering, it is safe to delete: it only overrides the
# lifecycle guard and is never committed.
resource "hcloud_server" "default" {
  lifecycle {
    prevent_destroy = false
  }
}
EOF
echo "==> Wrote temporary prevent_destroy override (auto-removed on exit)."

# Re-init so Terraform picks up the override in its module config.
terraform init "${INIT_ARGS[@]}" >/dev/null

# ─── Terraform plan (destroy preview) ────────────────────────────────────────

echo ""
echo "==> [${HEROBIDS_ENV}] Previewing resources to destroy..."
# shellcheck disable=SC2086
terraform plan -destroy ${TF_CLI_ARGS}

# ─── Confirmation ────────────────────────────────────────────────────────────

if [[ "${AUTO_APPROVE}" == "true" ]]; then
  echo ""
  echo "==> --yes/--auto-approve passed: skipping confirmation prompt."
else
  echo ""
  printf "\033[1;31m⚠️  This will DESTROY the '%s' environment and all its data.\033[0m\n" "${HEROBIDS_ENV}"
  echo "   Servers, volumes (DB/Redis), and the private network will be permanently deleted."
  echo ""
  read -rp "Type the environment name '${HEROBIDS_ENV}' to confirm: " CONFIRM || {
    echo ""
    echo "Aborted (no interactive input available). Use --yes for automated runs."
    exit 1
  }
  if [[ "${CONFIRM}" != "${HEROBIDS_ENV}" ]]; then
    echo "Aborted — input did not match '${HEROBIDS_ENV}'."
    exit 0
  fi
fi

# ─── Terraform destroy ───────────────────────────────────────────────────────

echo ""
echo "==> [${HEROBIDS_ENV}] Running terraform destroy..."
if [[ "${AUTO_APPROVE}" == "true" ]]; then
  # shellcheck disable=SC2086
  terraform destroy -auto-approve ${TF_CLI_ARGS}
else
  # shellcheck disable=SC2086
  terraform destroy ${TF_CLI_ARGS}
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Teardown Complete — ${HEROBIDS_ENV}"
echo "========================================"
echo ""
echo "  The '${HEROBIDS_ENV}' infrastructure has been destroyed."
echo "  Workspace state is preserved (now empty). Re-provision with:"
echo "    ./scripts/provision.sh --env ${HEROBIDS_ENV} --var-file ${HEROBIDS_ENV}.tfvars"
echo ""
echo "  NOTE: DNS records and the S3 state bucket were NOT modified."
echo ""
echo "========================================"
