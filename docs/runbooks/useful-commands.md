# Herobids useful commands

- production ip - 167.233.213.107
- staging ip - 138.199.172.202

## local

Run both herobids and the external trading service it depends
```sh
scripts/shell/run/reset-and-run-xstack.sh
```

Test Stripe checkout + webhooks locally — see [stripe-local-webhook-testing.md](./stripe-local-webhook-testing.md)
```sh
scripts/shell/run/dev-with-stripe-webhook.sh
```

Tag release the specified version, updating changelog and package.json
```sh
scripts/shell/ops/release.sh <version> --all
```

## staging|production

ssh into remote server
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'curl https://api.staging.traderton.com/health/ready'
```

> **SSH key warning:** `infra/hetzner/scripts/_ssh_opts.sh` picks the SSH key when it is sourced, and defaults to production. If you source it yourself to run ad-hoc `ssh`, set `HEROBIDS_ENV=staging` before sourcing. Setting it afterwards keeps the production key, and staging rejects it with `Permission denied (publickey,password)`. Scripts that take `--env` are not affected, because `parse_env_flag` re-resolves the key.
>
> ```sh
> export HEROBIDS_ENV=staging
> source infra/hetzner/scripts/_ssh_opts.sh
> ssh ${SSH_OPTS} root@138.199.172.202 'hostname'
> ```

```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 "ls -d /opt/herobids/infra/hetzner/.terraform-envs/staging 2>&1 && echo 'exists' || echo 'not yet'"
```

- infra/hetzner/scripts/setup-env.sh --env staging --file infra/hetzner/.env.staging

- infra/hetzner/scripts/push.sh --env staging   # app only: git pull + build + compose up. Does NOT converge the control plane (autoscaler/Nomad/UFW config).

- infra/hetzner/deploy.sh --env staging 138.199.172.202 --env-file infra/hetzner/.env.staging  # full chain incl. setup-control-plane.sh (converge). Use this when infra/autoscaler/control-plane config or .env changed, since hcloud_server.default ignores user_data and only converge keeps it current.

- infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging --skip-deploy --start-stopped --start-interval=30 --restart-running --include-live

- DEPLOY_REF=origin/feat/safe-capacity-p9-staging infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging --skip-deploy  # run the feature-branch copy of the script

- infra/hetzner/scripts/reset-and-run.sh --env staging 138.199.172.202 --env-file .env.ops.staging

- HEROBIDS_ENV=staging  scripts/shell/ops/download-eval-reports.sh

```sh
curl -v --resolve staging.openaidom.com:443:138.199.172.202 https://staging.openaidom.com
```

```sh
curl -v --resolve openaidom.com:443:167.233.213.107 https://openaidom.com
```

```sh
BASE_URL=http://localhost:8090 pnpm exec playwright test --reporter=line 2>&1 | tail -150
```

```sh
infra/hetzner/scripts/logs.sh --env production 167.233.213.107 api
ssh -i ~/.ssh/herobids_deploy_key root@167.233.213.107 'docker inspect --format "{{json .State.Health}}" herobids-api-1'
ssh -i ~/.ssh/herobids_deploy_key root@167.233.213.107 'docker exec herobids-api-1 node -e "fetch(\"http://127.0.0.1:3000/health\").then(r=>console.log(r.status)).catch(console.error)"'
```

prune docker on remote

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 'docker builder prune -f'

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 'docker image prune -f'

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'journalctl --disk-usage; du -sh /var/log/* 2>/dev/null | sort -h | tail -10'