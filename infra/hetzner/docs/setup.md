- Create production.tfvars - see infra/hetzner/docs/setup-tfvars.md

- Create the server: `./scripts/provision.sh --env production --var-file production.tfvars`

- Read the production ip: `terraform output -var-file=production.tfvars -raw server_ipv4`

- Use the IP in infra/hetzner/docs/setup-domain.md