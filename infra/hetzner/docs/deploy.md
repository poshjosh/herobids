
# Deploy

For the initial one-time setup, see: infra/hetzner/docs/setup.md

## Steps

### Provision the server (If need)

```sh
./scripts/provision.sh --env staging --var-file staging.tfvars
```

### Upload staging env file

```sh
./scripts/setup-env.sh --env staging <server_ipv4> --file .env.staging
```

### Deploy to staging
```sh
./deploy.sh --env staging <server_ipv4> --env-file .env.staging
```

### Seed staging admin (if needed)
```sh
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=test-pass ./scripts/seed-admin.sh --env staging
```

### Run smoke test
Follow the runbook at: the runbook at `docs/runbooks/staging-smoke-test.md`.

```sh
herobids/infra/hetzner/scripts/smoke-test.sh --env staging
```