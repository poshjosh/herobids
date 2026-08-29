#!/usr/bin/env bash

set -euo pipefail

ENV="production"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.." && pwd

echo "Sourcing your credentials"

set -a
source .env.backend
set +a

echo "Migrating ${ENV} state to S3"

terraform init -migrate-state \
  -backend-config="bucket=${TF_BACKEND_BUCKET}" \
  -backend-config="key=herobids/${ENV}/terraform.tfstate" \
  -backend-config="region=${TF_BACKEND_REGION}"
# Answer "yes" to copy existing state

echo "Verify the migration worked"

terraform workspace select "${ENV}"

echo "Display existing resources"

terraform state list
