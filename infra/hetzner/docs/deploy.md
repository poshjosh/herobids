
# Deploy

For the initial one-time setup (new server, new deploy key, DNS), see:
`infra/hetzner/docs/setup.md`. For the full "which doc do I want" index
(enabling Nomad, teardown/rebuild, production gotchas), see `README.md` in
this directory.

This doc covers steady-state deploys — a server already exists and is
healthy. Examples below use `staging`; substitute `--env production` and the
matching `.env.production`/production server IP to target production (see
`docs/runbooks/production-notes.md` for what's genuinely different there,
not just the environment name).

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
Follow the runbook at: `docs/runbooks/reprovision-runbook.md` step 10.

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