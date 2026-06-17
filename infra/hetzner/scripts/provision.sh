#!/usr/bin/env bash
# provision.sh — Terraform init + apply for the Herobids Hetzner deployment.
#
# Pre-flight checks:
#   - terraform.tfvars must exist (not just the .example).
#     Copy terraform.tfvars.example → terraform.tfvars and fill in the values.
#
# Usage:
#   infra/hetzner/scripts/provision.sh
#
# Requires:
#   - terraform (>= 1.0)
#   - HCLOUD_TOKEN set in the environment or in terraform.tfvars

set -euo pipefail

# ─── Resolve terraform directory ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
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
  exit 1
fi

# ─── Terraform init ──────────────────────────────────────────────────────────

echo "==> Running terraform init..."
terraform init

# ─── Terraform apply ─────────────────────────────────────────────────────────

echo ""
echo "==> Running terraform apply..."
terraform apply
