---
name: trading-boundary-ops
description: >-
  Operate and verify the herobids ↔ traderton trading boundary on staging:
  read deployed state (SHAs, image digests, Terraform outputs, endpoint
  health), run read-only signed boundary probes, and execute the Phase 1
  operational-readiness behavioral checks (fail-closed on outage, recovery,
  idempotency, HMAC enforcement). Use when asked to check boundary health,
  verify staging deployment, prove operational readiness, pin deployed release
  SHAs, or run boundary resilience checks.
---

# Trading Boundary Ops (herobids ↔ traderton, staging)

Operational knowledge for an engineering agent working with the deployed
trading boundary. The boundary is traderton's REST service that herobids
consumes; the two meet only at a URL + HMAC (independent/public model). This
skill is **verification and observation**, plus the operator-gated boundary
restart checks. It does not deploy, reprovision, or mutate config.

> **Secrets rule:** never hardcode HMAC secrets, tokens, or private keys here or
> in any probe. Reference key *paths* and read live creds from the running
> container env at runtime (see §Signed probe). Host IPs/DNS are already in
> committed docs, so they are fine to name.

## 1. Topology & access (saves rediscovery)

| Thing | Value |
|---|---|
| herobids repo (local) | `~/dev_ai/herobids` |
| traderton repo (local) | `~/dev_ai/traderton` |
| herobids staging control plane | `138.199.172.202` · deploy dir `/opt/herobids` |
| herobids SSH key | `~/.ssh/herobids_deploy_key` |
| traderton staging host | DNS `api.staging.traderton.com` (currently `2.28.19.89`) |
| traderton SSH key | `~/.ssh/traderton_deploy_staging_key` |
| boundary health endpoint | `https://api.staging.traderton.com/health/ready` |
| boundary invoke path | `POST /internal/v1/tools:invoke` |
| herobids container with node | `herobids-worker-1` (or `herobids-api-1`) |
| traderton boundary container | `staging-boundary-1` (+ `staging-postgres-1`, `staging-redis-1`, `staging-caddy-1`) |

Host IPs come from Terraform state/DNS, not from literals in scripts. If an IP
changed, resolve it: `dig +short api.staging.traderton.com` for traderton; the
herobids `server_ipv4` output for herobids (§3).

## 2. Gotchas (each one cost real time to discover)

1. **Hosts have no `node` on the PATH.** Run Node probes *inside* a container:
   `docker cp probe.mjs herobids-worker-1:/tmp/ && docker exec herobids-worker-1 node /tmp/probe.mjs`.
2. **macOS has no `timeout`.** Use SSH's own `-o ConnectTimeout=…` and, in Node,
   `AbortSignal.timeout(ms)`. Do not reach for `timeout`/`gtimeout`.
3. **Local git checkouts LAG the deployed hosts.** For a deployed SHA, read it
   off the host (`git rev-parse HEAD` in `/opt/herobids`; `docker inspect` the
   running image for traderton), never from the local clone.
4. **Zscaler breaks local `curl` to `*.openaidom.com` / `*.traderton.com`.** A
   local timeout is a vantage artifact, not an outage. Probe from the host.
5. **The boundary is per-call fail-closed, NOT snapshot health-gated.** herobids
   has no background boundary health-poller that adds/removes boundary tools
   from a visibility snapshot. A down boundary surfaces as a typed
   `transport_error` / `precondition.not_ready` on the call itself. (See
   `apps/worker/src/traderton/write-adapter.ts`, `tools/traderton-read.ts`,
   `apps/worker/src/index.ts` boundary construction.) `worker.agents.healthCheckIntervalMs`
   is the *agent-session* monitor, a different concern.
6. **Deployed traderton has no `.git` checkout** — it is image-based. Read the
   SHA from the running image tag/digest, not a repo.

## 3. Read deployed state (read-only)

**Endpoint health (from the host, Zscaler-free):**
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://api.staging.traderton.com/health/ready'
# expect 200
```

**herobids deployed SHA + image digests:**
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'cd /opt/herobids && git rev-parse HEAD && git log -1 --format="%h %s (%ci)";
   docker images --digests --format "{{.Repository}}:{{.Tag}} {{.Digest}}" | grep -i herobids'
```

**traderton deployed SHA (from the running image) + container state:**
```sh
ssh -i ~/.ssh/traderton_deploy_staging_key root@2.28.19.89 \
  'docker inspect --format "{{.Config.Image}}" staging-boundary-1;
   img=$(docker inspect --format "{{.Image}}" staging-boundary-1);
   docker image inspect "$img" --format "{{join .RepoDigests \"\n\"}}";
   docker ps --format "{{.Names}}\t{{.Status}}"'
# the image tag "sha-<40hex>" IS the deployed traderton commit SHA
```

**herobids Terraform outputs (read-only, isolated data dir):**
```sh
cd ~/dev_ai/herobids/infra/hetzner
set -a; . ./.env.backend; set +a
export TF_DATA_DIR="$(mktemp -d)"; trap 'rm -rf "$TF_DATA_DIR"' EXIT
terraform init -input=false -reconfigure \
  -backend-config="bucket=${TF_BACKEND_BUCKET}" \
  -backend-config="key=herobids/staging/terraform.tfstate" \
  -backend-config="region=${TF_BACKEND_REGION}"
terraform workspace select staging
terraform output   # environment, server_ipv4, agent_node_private_ips, nomad_enabled, private_network_*
```

## 4. Signed read-only probe (the 005 canonical string)

Use a **read** tool (`get_price`) so the probe is side-effect-free. The probe
reads creds from the container env — nothing is hardcoded. (herobids config:
the `externalBackends.traderton` entry in `config/default.yaml`; the env names
`TRADERTON_BOUNDARY_*` are unchanged, and the HMAC secret is the env var named
by its `caller.hmacSecretRef`. Agent containers receive the resolved entry as
`EXTERNAL_BACKEND_CONFIG_JSON`.) Canonical string
(from `packages/domain/src/external-backend/sign.ts`):

```
POST\n/internal/v1/tools:invoke\n<X-Traderton-Timestamp>\n<SHA256(rawBody) hex>
signature = "sha256=" + HMAC_SHA256(secret, canonical)   # lowercase hex
```

Required headers (all lower-cased): `content-type`, `x-traderton-consumer-id`,
`x-traderton-key-id`, `x-traderton-timestamp`, `x-traderton-signature`,
`x-request-deadline-at` (must equal the body `deadlineAt`). The invoke envelope
requires: `contractVersion`, `requestId`, `idempotencyKey`, `correlationId`,
`issuedAt`, `deadlineAt`, `caller`, `toolName`, `subject`, `payload`.

Probe shape (write to a temp `.mjs`, `docker cp` into `herobids-worker-1`, run,
then delete from host + container):

```js
import { createHash, createHmac, randomUUID } from 'node:crypto';
const baseUrl = (process.env.TRADERTON_BOUNDARY_URL||'').replace(/\/+$/,'');
const consumerId = process.env.TRADERTON_BOUNDARY_CONSUMER_ID||'herobids';
const keyId = process.env.TRADERTON_BOUNDARY_KEY_ID||'herobids-k1';
const secret = process.env.TRADERTON_BOUNDARY_HMAC_SECRET||'';
const rid = process.env.PROBE_REQUEST_ID||randomUUID();
const P='/internal/v1/tools:invoke', ts=new Date().toISOString();
const deadlineAt=new Date(Date.now()+15000).toISOString();
const env={contractVersion:'1.0',requestId:rid,idempotencyKey:process.env.PROBE_IDEMPOTENCY_KEY||rid,
  correlationId:rid,issuedAt:ts,deadlineAt,caller:{consumerId,keyId},toolName:'get_price',
  subject:{ownerId:consumerId,actor:{type:'system',id:'readiness-probe'}},payload:{symbol:'BTC',chain:'ethereum'}};
const body=JSON.stringify(env);
const sig='sha256='+createHmac('sha256',secret).update(`POST\n${P}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
try{const r=await fetch(baseUrl+P,{method:'POST',headers:{'content-type':'application/json',
  'x-traderton-consumer-id':consumerId,'x-traderton-key-id':keyId,'x-traderton-timestamp':ts,
  'x-traderton-signature':sig,'x-request-deadline-at':deadlineAt},body,signal:AbortSignal.timeout(12000)});
  console.log(JSON.stringify({httpStatus:r.status,body:(await r.text()).slice(0,500)}));}
catch(e){console.log(JSON.stringify({transport_error:String(e?.message||e)}));}  // fail-closed path
```

Run it with the real creds from the container:
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'docker cp /root/probe.mjs herobids-worker-1:/tmp/probe.mjs; docker exec herobids-worker-1 node /tmp/probe.mjs'
```
A `validation.invalid_payload` for a bad symbol/chain still PROVES the full
path (auth + envelope + routing). You do not need a successful price.

## 5. Operational-readiness behavioral checks (OPERATOR-GATED)

Stopping/restarting `staging-boundary-1` is a brief live outage — **get explicit
operator approval first.** Minimize the window; always restore and verify.
Expected results (verified 2026-10-01):

1. **Baseline (UP):** signed probe → HTTP 200, ~100ms. Auth + routing work.
2. **C2 — down fails closed:** `ssh traderton 'docker stop staging-boundary-1'`
   → probe returns fast (HTTP 502 via Caddy, ~100ms, no hang) and
   `herobids-worker-1` stays Up with no error/stack in logs.
3. **C3 — recovery:** `docker start staging-boundary-1`; poll `/health/ready`
   until 200 (~8–9s); next probe → 200.
4. **C4 — idempotency:** reissue the same `PROBE_IDEMPOTENCY_KEY` after recovery
   → identical outcome. (Read tool proves transport idempotency; durable
   write-dedup is a Step 16 obligation.)
5. **C5 — HMAC:** unsigned `POST …/tools:invoke` → `authentication.invalid_caller`.

Cleanup: remove the probe from the host and container; confirm
`staging-boundary-1` is `healthy` and `/health/ready` → 200.

## 6. What this skill does NOT do

- Deploy, reprovision, reset, or change DNS/TLS/secrets — see
  `infra/hetzner/docs/staging-reprovision-runbook.md`.
- Produce latency/throughput metrics — the codebase has **no** metrics system
  (no prom-client/otel/statsd/`/metrics`). Those numbers require building
  instrumentation first; do not promise them.
- Shadow/differential write-path cutover proof — that is roadmap Step 16 against
  the pinned oracle SHA, not a Phase 1 check.

## References

- `infra/hetzner/docs/runbooks/phase1-operational-readiness.md` (the runbook this skill operationalizes)
- `infra/hetzner/docs/staging-reprovision-runbook.md`
- `packages/domain/src/external-backend/{sign,client,contract}.ts` (signing + invoke contract)
- `docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md` (roadmap + Step 16)
