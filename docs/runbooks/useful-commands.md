# Herobids useful commands

## local

Run both herobids and the external trading service it depends
```sh
scripts/shell/run/reset-and-run-xstack.sh
```

Tag release the specified version, updating changelog and package.json
```sh
scripts/shell/ops/release.sh <version> --all
```

others

- scripts/shell/ops/sidestep-zscaler-start.sh --domain staging.openaidom.com --ssh-target root@138.199.172.202
- scripts/shell/ops/sidestep-zscaler-stop.sh

## staging|production

ssh into remote server
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'curl https://api.staging.traderton.com/health/ready'
```

- infra/hetzner/scripts/setup-env.sh --env staging --file infra/hetzner/.env.staging
- infra/hetzner/scripts/push.sh --env staging 
- infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging
- infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging --skip-deploy --include-live
- infra/hetzner/scripts/reset-and-run.sh --env staging 138.199.172.202 --env-file .env.ops.staging
- HEROBIDS_ENV=staging  scripts/shell/ops/download-eval-reports.sh

```sh
curl -v --resolve staging.openaidom.com:443:78.46.192.37 https://staging.openaidom.com
```

```sh
curl -v --resolve openaidom.com:443:167.233.213.107 https://openaidom.com
```
