#!/usr/bin/env bash
# provision.sh — Terraform init + apply for the Herobids Hetzner deployment.
#
# Pre-flight checks:
#   - terraform.tfvars must exist (not just the .example).
#     Copy terraform.tfvars.example → terraform.tfvars and fill in the values.
#   - Set environment = "staging" or "production" in terraform.tfvars
#     (or pass --env on the command line).
#
# Usage:
#   infra/hetzner/scripts/provision.sh [--env <staging|production>]
#
# Environment:
#   HEROBIDS_ENV   Deployment environment (default: production).
#                  Terraform reads this via the environment variable in terraform.tfvars.
#                  The --env flag is informational here and sets HEROBIDS_ENV for
#                  subsequent script calls; it does not override terraform.tfvars.
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

# ─── Parse environment flag ──────────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

cd "${TF_DIR}"

# Verify terraform is installed
if ! command -v terraform &>/dev/null; then
  echo "ERROR: terraform not found in PATH. Install terraform >= 1.0." >&2
  echo "  macOS: brew install terraform" >&2
  echo "  Linux: https://developer.hashicorp.com/terraform/install" >&2
  exit 1
fi

# ─── Pre-flight: terraform.tfvars must exist ─────────────────────────────────

if [[ ! -f terraform.tfvars ]]; then
  echo "ERROR: terraform.tfvars not found in ${TF_DIR}" >&2
  echo "" >&2
  echo "Create it from the example:" >&2
  echo "  cp terraform.tfvars.example terraform.tfvars" >&2
  echo "  # edit terraform.tfvars and fill in required values" >&2
  echo "  # Set environment = \"staging\" or environment = \"production\" in terraform.tfvars" >&2
  exit 1
fi

# ─── Terraform init ──────────────────────────────────────────────────────────

echo "==> [${HEROBIDS_ENV}] Running terraform init..."
terraform init

# ─── Terraform apply ─────────────────────────────────────────────────────────

echo ""
echo "==> [${HEROBIDS_ENV}] Running terraform apply..."
terraform apply
