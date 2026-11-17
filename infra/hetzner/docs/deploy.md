
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

### Agent image pin (`NOMAD_AGENT_IMAGE`)
Staging and production pin agents to an immutable
`ghcr.io/poshjosh/herobids-agent:sha-<commit>` tag, set by hand in
`infra/hetzner/.env.<env>`. A deploy updates the worker and API but **not** the pin,
so new agents keep launching on the pinned image until someone moves it. The two
environments work the same way.

Why it is a pin: the image carries the sandbox egress rules, so a probe decides when a
new image reaches agents, and rollback is changing one value.

Every deploy now ends with a check (`scripts/check-agent-image-pin.sh`, run by
`push.sh`, `maintenance-restart.sh` and again by `deploy.sh`). It prints a bold
bold banner (no colour) when the pin is unset, is not a `sha-<commit>` tag, or lags the
deployed commit. It lists the sandbox/entrypoint files that changed since the pin. It
only warns and never fails the deploy. Run it any time:
```sh
ssh -i ~/.ssh/herobids_deploy_key root@<server_ipv4> \
  'cd /opt/herobids && HEROBIDS_ENV=staging infra/hetzner/scripts/check-agent-image-pin.sh'
```
#### Release the latest agent image
When the banner appears, run the command it prints, from your machine at the repo root
(same for staging and production):
```sh
infra/hetzner/scripts/release-agent-image.sh --env staging --dry-run   # verify and probe only
infra/hetzner/scripts/release-agent-image.sh --env staging             # release
```
`release-agent-image.sh` releases the commit that is deployed on the server. It stops at
the first failure and changes nothing until step 4:
1. Reads the deployed commit (or `--sha <40-char commit>`).
2. Checks that CI published `ghcr.io/poshjosh/herobids-agent:sha-<commit>` (GitHub
   Actions "Build and Push Agent Image"). If it is missing, wait for the workflow, or
   check that it succeeded, and run the command again.
3. Probes the image on a live agent node with `probe-agent-image.sh`: it pulls the image
   and runs it with `NET_ADMIN` only, as Nomad would. Rows K0 to K7 are the sandbox
   checks from sandbox plan S3 (egress marker, agent user blocked from the control plane,
   public internet and allowlisted browser pool reachable, root unrestricted, refusal
   without `NET_ADMIN`, refusal to start when the rules cannot install). It checks the
   sandbox, not the whole agent. K8 (loopback listeners) stays a manual check.
4. Sets `NOMAD_AGENT_IMAGE` in `infra/hetzner/.env.<env>`, uploads it with
   `setup-env.sh`, recreates the worker (`docker compose up -d --force-recreate --no-deps
   worker`; a plain `restart` does not re-read the env file) and confirms the worker
   reports the new value.
5. Asks whether to relaunch the running agents (`--relaunch` / `--no-relaunch` skip the
   question). Running agents keep their old image until relaunched. Live-mode agents are
   skipped; relaunch them deliberately with
   `maintenance-restart-from-local.sh --env <env> --skip-deploy --include-live`.

If the probe fails, the pin is not changed and the failing row is printed. Do not release
that image. Roll back to the previous image with
`release-agent-image.sh --env <env> --sha <previous commit>` (the script prints it at the
end of a release). Agents launched before a release run an older image than the worker by
design; the check shows it. See lesson 22 in `auto-scaling/lessons-learnt.md` for what a
forgotten pin cost.

Not automated yet: running this from CI after every `main` build so the pin follows
automatically. The probe script is written to be reusable for that.

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