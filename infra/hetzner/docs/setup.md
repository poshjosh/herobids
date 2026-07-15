- Follow instructions here: infra/hetzner/docs/setup-domain.md

- `./scripts/provision.sh --env production --var-file production.tfvars`

- `terraform output -var-file=production.tfvars -raw server_ipv4`

- Follow instructions here: infra/hetzner/docs/setup-tfvars.md