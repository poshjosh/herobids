---
name: access-remote-targets
description: 'Read-only access to a remote herobids target (staging or production) over SSH: agent allocations on Nomad (namespace herobids-agents), logs, Postgres, Redis, and files inside an agent workspace. Use whenever another skill (evaluate-agent, evaluate-agent-and-fix, evaluate-job-search-agent) runs with a deployment-target other than local docker compose, or when asked to check agent nodes, allocations or agent logs on staging or production.'
argument-hint: 'environment (staging or production) and agent-id (e.g. "env=staging agent-id=abc123")'
---

# Access Remote Targets (read-only)

Shared recipe for reading evidence from staging or production. Calling skills decide what to collect and how to judge it. This skill only says how to reach the data safely. Note the target in the calling skill's report.

On a remote target the platform containers run on the server (reach them over SSH). Each agent runs as a Nomad allocation in namespace `herobids-agents`, job `agent-<agent-id>`, task `agent`.

## When to Use

- A calling skill has `deployment-target` set to staging or production.
- You need agent logs, workspace files, Postgres rows or Redis keys from a remote target.
- You need to see which node and allocation an agent is on.

## When Not to Use

- Local docker compose: use the `docker` commands in the calling skill.
- Any change to a remote target (deploy, restart, Terraform, release scripts). Those are out of scope and need the user's approval.
- The traderton boundary hosts: see `.github/skills/trading-boundary-ops/SKILL.md`.

## Targets

| | staging | production |
|-|---------|------------|
| Server IP | `138.199.172.202` | `167.233.213.107` |
| SSH key | `~/.ssh/herobids_deploy_key` | the production key (`infra/hetzner/scripts/_ssh_opts.sh` with `HEROBIDS_ENV=production`) |
| Token file | `infra/hetzner/.env.eval.staging` | `infra/hetzner/.env.eval.production` |

IPs and keys are also listed in `docs/runbooks/useful-commands.md`. If sourcing `_ssh_opts.sh` fails with a key warning, pass the key with `ssh -i` as below. When sourcing it, set `HEROBIDS_ENV` first, because it defaults to production.

## Credential

Use only `NOMAD_READONLY_TOKEN` from the token file for Nomad. Never use `NOMAD_TOKEN` (the management token) from `.env.staging`, `.env.production` or `.env.temp`, even if it is on disk.

If the token file or the token is missing or rejected, stop and tell the user to run `infra/hetzner/scripts/setup-nomad-readonly.sh --env <env> --env-file .env.<env>`. Do not work around it and do not borrow another credential. Postgres and Redis need no token, so collect that evidence anyway and mark the log, workspace and `AGENT_CONFIG` checks UNVERIFIED.

Pass the token to the server on SSH stdin, never as an argument, in a file, or in output.

## Helpers

```sh
HOST=138.199.172.202; KEY=~/.ssh/herobids_deploy_key       # staging
TOKEN=$(grep -E '^NOMAD_READONLY_TOKEN=' infra/hetzner/.env.eval.staging | cut -d= -f2-)
AGENT=<agent-id>; NS=herobids-agents

# Nomad on the server (token over stdin)
nomad_ro() { printf '%s' "$TOKEN" | ssh -i "$KEY" -o BatchMode=yes root@"$HOST" \
  "read -r NOMAD_TOKEN; export NOMAD_TOKEN NOMAD_ADDR=http://127.0.0.1:4646; $*"; }
# Postgres and Redis (no token needed)
psql_ro()  { ssh -i "$KEY" -o BatchMode=yes root@"$HOST" 'docker exec -i herobids-postgres-1 psql -U herobids -d herobids -At'; }  # SQL on stdin
redis_ro() { ssh -i "$KEY" -o BatchMode=yes root@"$HOST" "docker exec -i herobids-redis-1 redis-cli $*"; }

ALLOC=$(nomad_ro "nomad job allocs -namespace=$NS -json agent-$AGENT | jq -r '[.[]|select(.ClientStatus==\"running\")][0].ID'")
```

For production, change `HOST`, `KEY` and the token file. macOS has no `timeout`; use `-o ConnectTimeout=<s>` on `ssh`.

## Local to remote equivalents

| Local (docker compose) | Remote |
|------------------------|--------|
| `docker logs herobids-agent-<id>` | `nomad_ro "nomad alloc logs -namespace=$NS $ALLOC agent"` and again with `-stderr` |
| `docker exec herobids-postgres-1 psql ...` | `psql_ro` with the SQL on stdin |
| `redis-cli ...` | `redis_ro "<command>"` |
| `docker cp herobids-agent-<id>:/workspace/<path> workspace/` | `nomad_ro "nomad alloc exec -namespace=$NS $ALLOC cat /workspace/<path>" > workspace/<name>` |
| listing with sizes | `nomad_ro "nomad alloc exec -namespace=$NS $ALLOC ls -la /workspace/<dir>"` |
| `docker inspect ... AGENT_CONFIG` | `nomad_ro "nomad alloc exec -namespace=$NS $ALLOC printenv AGENT_CONFIG"` piped through `jq` locally to only the fields needed. Do not save or print the whole value |
| agent image | `nomad_ro "nomad job inspect -namespace=$NS agent-$AGENT" \| jq -r '.Job.TaskGroups[].Tasks[].Config.image'`. Extract only the image; the job spec may contain secrets. The pinned worker image is also `docker exec herobids-worker-1 printenv NOMAD_AGENT_IMAGE` |
| platform logs (`api`, `worker`) | `ssh -i "$KEY" root@"$HOST" 'docker logs herobids-worker-1 2>&1'` (same for `herobids-api-1`), scoped with `--since` |

Also useful: `nomad_ro "nomad node status"` and `nomad_ro "nomad job status -namespace=$NS agent-$AGENT"`.

## Constraints

- **Read-only, enforced by this rule.** The read-only Nomad token includes `alloc exec`, so nothing technical stops a write. Inside the agent container run only `cat`, `ls`, `printenv <one named variable>` and similar reads. Never write, delete or kill anything there.
- Nomad: only `job status|allocs|inspect`, `alloc logs|fs|exec` (read commands), `node status`.
- Postgres: only `SELECT` and `\d`.
- Redis: only `TYPE`, `GET`, `HGETALL`, `TTL`, `EXISTS` and `--scan`.
- No Terraform, no `docker` writes (`stop`, `restart`, `rm`, `prune`, `cp` into a container), no deploy or release scripts.
- Do not read, print or use `NOMAD_TOKEN` or any other secret. Keep the whole `AGENT_CONFIG`, job specs and environment variables that may hold keys out of the output, the chat and the output folder.
- Fixes found during an evaluation are made in the local repository, never on the remote host.
