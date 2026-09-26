
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
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='test-pass' ./scripts/seed-admin.sh --env staging
```

### Run smoke test
Follow the runbook at: the runbook at `docs/runbooks/staging-smoke-test.md`.

```sh
./scripts/smoke-test.sh --env staging
```

more verifications

```sh
# a. image is on GHCR
docker manifest inspect ghcr.io/poshjosh/herobids-agent:latest

# b. agent node can pull it
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'ssh -i /root/.ssh/deploy_key root@10.0.0.3 "docker pull ghcr.io/poshjosh/herobids-agent:latest"'

# c. start thyper (65c09baf…) / tintel (47143a9f…) and confirm NO
#    "Stale agent start detected" / "Critical execution failure" in:
docker logs herobids-worker-1 --since 5m | grep -iE "stale|critical|launch"
```