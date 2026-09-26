
# Deploy

For the initial one-time setup, see: infra/hetzner/docs/setup.md

## Steps

### Upload staging env file

```sh
./scripts/setup-env.sh --env staging --file .env.staging
```

### Deploy to staging
```sh
./deploy.sh --env staging --env-file .env.staging
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