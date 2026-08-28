#!/usr/bin/env bash
# provision.sh — Terraform init + apply for the Herobids Hetzner deployment.
#
# Pre-flight checks:
#   - terraform.tfvars must exist (not just the .example).
#     Copy terraform.tfvars.example → terraform.tfvars and fill in the values.
#     Or use --var-file to specify a per-environment tfvars file.
#   - Set environment = "staging" or "production" in terraform.tfvars
#     (or pass --env on the command line).
#
# Usage:
#   infra/hetzner/scripts/provision.sh [--env <staging|production>] [--var-file <path>] [--backend-env-file <path>]
#   infra/hetzner/scripts/provision.sh --env staging --var-file staging.tfvars --backend-env-file .env.backend
#   infra/hetzner/scripts/provision.sh --env production --var-file production.tfvars
#
# Environment:
#   HEROBIDS_ENV   Deployment environment (default: production).
#                  Terraform reads this via the environment variable in terraform.tfvars.
#                  The --env flag is informational here and sets HEROBIDS_ENV for
#                  subsequent script calls; it does not override terraform.tfvars.
#
#   TF_CLI_ARGS    Extra arguments passed to terraform commands (e.g., -var-file).
#
# Requires:
#   - terraform (>= 1.0)
#   - HCLOUD_TOKEN set in the environment or in terraform.tfvars

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source _ssh_opts.sh for HEROBIDS_ENV and parse_env_flag (ignores SSH key for provision)
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse arguments ─────────────────────────────────────────────────────────

VAR_FILE=""
TF_CLI_ARGS=""
AUTO_APPROVE=false
BACKEND_ENV_FILE=""

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
    --help|-h)
      echo "Usage: $0 [--env <staging|production>] [--var-file <path>] [--backend-env-file <path>] [--yes]" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  --env <name>              Target environment: staging or production." >&2
      echo "  --var-file <path>         Path to terraform.tfvars file for this environment." >&2
      echo "  --backend-env-file <path> Path to env file with S3 backend credentials" >&2
      echo "                            (TF_BACKEND_BUCKET, AWS_ACCESS_KEY_ID, etc.)." >&2
      echo "                            Sourced before terraform init. Falls back to" >&2
      echo "                            shell environment variables if omitted." >&2
      echo "  --yes, --auto-approve     Skip the confirmation prompt and auto-approve apply." >&2
      echo "  Note: production applies require an additional 'yes' confirmation." >&2
      echo "" >&2
      echo "Terraform workspaces are automatically managed from --env." >&2
      echo "Each environment (staging/production) gets its own isolated state." >&2
      echo "" >&2
      echo "Examples:" >&2
      echo "  $0 --env staging --var-file staging.tfvars --backend-env-file .env.backend" >&2
      echo "  $0 --env production --var-file production.tfvars" >&2
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

# ─── Resolve var-file ────────────────────────────────────────────────────────

if [[ -n "${VAR_FILE}" ]]; then
  # If a relative path is given, resolve it relative to the TF_DIR
  if [[ "${VAR_FILE}" != /* ]]; then
    VAR_FILE="${TF_DIR}/${VAR_FILE}"
  fi

  if [[ ! -f "${VAR_FILE}" ]]; then
    echo "ERROR: --var-file '${VAR_FILE}' does not exist." >&2
    echo "Create it from the example:" >&2
    echo "  cp ${VAR_FILE}.example ${VAR_FILE}" >&2
    exit 1
  fi

  TF_CLI_ARGS="-var-file=${VAR_FILE}"
  echo "==> Using var-file: ${VAR_FILE}"
fi

# ─── Pre-flight: terraform.tfvars must exist (unless --var-file provided) ────

if [[ -z "${VAR_FILE}" ]]; then
  if [[ ! -f terraform.tfvars ]]; then
    echo "ERROR: terraform.tfvars not found in ${TF_DIR}" >&2
    echo "" >&2
    echo "Create it from the example:" >&2
    echo "  cp terraform.tfvars.example terraform.tfvars" >&2
    echo "  # edit terraform.tfvars and fill in required values" >&2
    echo "  # Set environment = \"staging\" or environment = \"production\" in terraform.tfvars" >&2
    echo "" >&2
    echo "Or use per-environment tfvars:" >&2
    echo "  $0 --env staging --var-file staging.tfvars" >&2
    echo "  $0 --env production --var-file production.tfvars" >&2
    exit 1
  fi
fi

# ─── Terraform workspace ─────────────────────────────────────────────────────

# Check BEFORE selecting — warn if still on deprecated default workspace
CURRENT_WS="$(terraform workspace show)"
if [[ "${CURRENT_WS}" == "default" ]]; then
  echo "" >&2
  echo "⚠️  WARNING: You are on the 'default' terraform workspace." >&2
  echo "   The default workspace is deprecated. Use --env staging|production." >&2
  echo "" >&2
fi

echo "==> Selecting terraform workspace: ${HEROBIDS_ENV}"
terraform workspace select "${HEROBIDS_ENV}" 2>/dev/null || \
  terraform workspace new "${HEROBIDS_ENV}" || {
    echo "ERROR: Failed to select or create terraform workspace '${HEROBIDS_ENV}'." >&2
    echo "Check that terraform is functional and the state is not corrupted." >&2
    exit 1
  }

# ─── Terraform init ──────────────────────────────────────────────────────────

echo "==> [${HEROBIDS_ENV}] Running terraform init..."

# Source backend env file if provided (--backend-env-file).
# This sets TF_BACKEND_BUCKET, AWS_ACCESS_KEY_ID, etc. from a file
# instead of requiring them as shell environment variables.
# The file uses KEY=VALUE format (same as autoscale.env on the server).
if [[ -n "${BACKEND_ENV_FILE}" ]]; then
  if [[ "${BACKEND_ENV_FILE}" != /* ]]; then
    BACKEND_ENV_FILE="${TF_DIR}/${BACKEND_ENV_FILE}"
  fi
  if [[ ! -f "${BACKEND_ENV_FILE}" ]]; then
    echo "ERROR: --backend-env-file '${BACKEND_ENV_FILE}' does not exist." >&2
    exit 1
  fi
  echo "==> Sourcing backend env file: ${BACKEND_ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${BACKEND_ENV_FILE}"
  set +a
fi

# Build S3 backend config flags from environment variables.
# The same env vars (TF_BACKEND_BUCKET, TF_BACKEND_REGION, etc.) are used
# by the control-plane autoscale services — keeping the config model consistent.
TF_BACKEND_BUCKET="${TF_BACKEND_BUCKET:-}"
TF_BACKEND_REGION="${TF_BACKEND_REGION:-us-east-1}"
TF_BACKEND_DYNAMODB_TABLE="${TF_BACKEND_DYNAMODB_TABLE:-}"

if [[ -z "${TF_BACKEND_BUCKET}" ]]; then
  echo "ERROR: TF_BACKEND_BUCKET is not set." >&2
  echo "The S3 remote backend requires:" >&2
  echo "  TF_BACKEND_BUCKET          — S3 bucket name" >&2
  echo "  TF_BACKEND_REGION          — AWS region (default: us-east-1)" >&2
  echo "  AWS_ACCESS_KEY_ID          — AWS credentials" >&2
  echo "  AWS_SECRET_ACCESS_KEY      — AWS credentials" >&2
  echo "  TF_BACKEND_DYNAMODB_TABLE  — DynamoDB table for state locking (optional)" >&2
  echo "" >&2
  echo "Example:" >&2
  echo "  export TF_BACKEND_BUCKET=herobids-terraform-state" >&2
  echo "  export TF_BACKEND_REGION=us-east-1" >&2
  echo "  export AWS_ACCESS_KEY_ID=AKIA..." >&2
  echo "  export AWS_SECRET_ACCESS_KEY=..." >&2
  echo "  $0 --env staging --var-file staging.tfvars" >&2
  exit 1
fi

INIT_ARGS=(-input=false \
  "-backend-config=bucket=${TF_BACKEND_BUCKET}" \
  "-backend-config=key=herobids/${HEROBIDS_ENV}/terraform.tfstate" \
  "-backend-config=region=${TF_BACKEND_REGION}" \
)

if [[ -n "${TF_BACKEND_DYNAMODB_TABLE}" ]]; then
  INIT_ARGS+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
fi

terraform init "${INIT_ARGS[@]}"

# ─── Terraform plan (preview) ────────────────────────────────────────────────

echo ""
echo "==> [${HEROBIDS_ENV}] Running terraform plan..."
# shellcheck disable=SC2086
terraform plan ${TF_CLI_ARGS}

# ─── Production confirmation ─────────────────────────────────────────────────

if [[ "${HEROBIDS_ENV}" == "production" ]]; then
  echo ""
  printf "\033[1;31m⚠️  PRODUCTION WORKSPACE — this will modify live production infrastructure.\033[0m\n"
  printf "\033[1;31m   Are you ABSOLUTELY sure you want to proceed?\033[0m\n"
  echo ""
  read -rp "Type 'yes' to confirm: " PROD_CONFIRM || {
    echo ""
    echo "Aborted (no interactive input available). Use --yes for automated runs (not recommended for production)."
    exit 1
  }
  if [[ "${PROD_CONFIRM}" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

if [[ "${AUTO_APPROVE}" == "true" ]]; then
  echo ""
  echo "==> --yes/--auto-approve passed: skipping confirmation prompt."
else
  echo ""
  read -rp "Apply this plan? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted. Re-run with the same arguments to apply."
    exit 0
  fi
fi

# ─── Terraform apply ─────────────────────────────────────────────────────────

echo ""
echo "==> [${HEROBIDS_ENV}] Running terraform apply..."
if [[ "${AUTO_APPROVE}" == "true" ]]; then
  # shellcheck disable=SC2086
  terraform apply -auto-approve ${TF_CLI_ARGS}
else
  # shellcheck disable=SC2086
  terraform apply ${TF_CLI_ARGS}
fi
