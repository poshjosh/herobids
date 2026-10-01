# Phase 1 Operational Readiness Runbook — Herobids ↔ Traderton (staging)

**Status:** living checklist
**Date:** 2026-10-01
**Scope:** roadmap `docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md`
Phase 1, Step 5 + Phase 1 Exit Criteria.
**Governing readiness spec:** `docs/features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md`

## What this is

Operational readiness is **verification of the already-deployed staging stacks**,
not new feature work. This runbook lists every readiness proof, marks each
`DONE` / `DEFERRED` / `N/A — no instrumentation`, and records the evidence
captured on 2026-10-01.

## Context the reader must know (pre-launch)

- **The product has not launched.** There are no external users and no durable
  data worth preserving. Per operator decision (2026-10-01), staging and
  production can be torn down and rebuilt at will.
- Consequently the **rollback-path requirement is NOT a blocker** here. Teardown
  + rebuild is the accepted recovery path pre-launch. This is a deliberate,
  recorded deviation from the generic readiness spec (which assumes a live
  predecessor to roll back to).
- **There is no metrics/telemetry system in the codebase** (verified — see
  §"Why there are no latency/throughput numbers"). Any readiness item expressed
  as a latency percentile, throughput, or boundary-overhead figure is therefore
  **not obtainable without first building instrumentation**, and is marked
  `N/A — no instrumentation` rather than pretended.

---

## A. Deployment & integration — DONE (verified 2026-10-01, read-only)

| # | Proof | Status | Evidence |
|---|---|---|---|
| A1 | Herobids staging is up | ✅ DONE | `https://staging.openaidom.com/api/health` → HTTP 200; DNS → `138.199.172.202`; 8 containers "Up 4 days (healthy)" on the host. |
| A2 | Herobids provisioned via Terraform (not hand-built) | ✅ DONE | Live state `herobids/staging/terraform.tfstate` (workspace `staging`): 9 resources, `environment=staging`, `nomad_enabled=true`, private net `12685156` / `10.0.0.0/16`, `agent_node_count=1`, agent private IP `10.0.0.3`. |
| A3 | Traderton deployed as an independent service | ✅ DONE | Host `2.28.19.89` (distinct from herobids): containers `staging-boundary-1`, `staging-postgres-1`, `staging-redis-1`, `staging-caddy-1`, all "Up 5 days (healthy)". Own Postgres/Redis + Caddy ingress. |
| A4 | Boundary reachable over HTTPS **from the real caller** | ✅ DONE | From the herobids host: `curl https://api.staging.traderton.com/health/ready` → HTTP 200. (A local-workstation curl fails on DNS due to Zscaler — a local-vantage artifact, not a service state.) |
| A5 | Herobids wired to consume the boundary | ✅ DONE | `herobids-api-1` container env `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com`; `.env.staging` carries HMAC secret + `CONSUMER_ID=herobids` + `KEY_ID=herobids-k1`. |
| A6 | The two repos meet only at a URL + HMAC (independent model) | ✅ DONE | No `terraform_remote_state` / shared-network handoff to Traderton in herobids `*.tf`. |

## B. Release pinning (roadmap decision D2) — DONE (verified 2026-10-01)

Deployed refs read **off the hosts** (authoritative), not from local checkouts.
Note both hosts are *behind* their local checkouts — which is exactly why the
host is the source of truth.

| Side | Deployed commit SHA | Image / digest | Source |
|---|---|---|---|
| Herobids (control plane `138.199.172.202:/opt/herobids`) | `a5f403cf07092cfe0ada05148283c04835f0cac1` ("Maintain code", 2026-09-27) | `herobids-api@sha256:d92ab817…`, `herobids-worker@sha256:1d911693…`, `herobids-agent@sha256:cf45a9ad…`, `herobids-web@sha256:29b8603c…`, `herobids-migrate@sha256:c8d68920…` | `git rev-parse HEAD` + `docker images --digests` on host |
| Traderton (boundary host `2.28.19.89`) | `41d9c2c1581e95e889fc7d644baaa67a5d98a4e4` | `ghcr.io/poshjosh/traderton@sha256:b7b9342718be0965086a3fbf2f0dca0c1125ad706675498e97a089a98ba90d6d` (tag `sha-41d9c2c1…`) | `docker inspect staging-boundary-1` on host |

> Local checkouts at capture time (ahead of deployed): herobids `98f32ca1`,
> traderton `49c4568b`. Re-capture this table after any redeploy.

## C. Behavioral readiness checks — DONE (executed live 2026-10-01, operator-approved)

These verify what the system actually exposes (typed failure codes + health
gating + fail-closed behavior), without any metrics system. **Architecture note
(verified in code):** herobids does **not** run a background boundary
health-poller that adds/removes boundary tools from a visibility snapshot.
Boundary availability is handled **per-call, fail-closed** — a down boundary
surfaces as a typed `transport_error` / `precondition.not_ready` on the call
itself (see `apps/worker/src/traderton/write-adapter.ts` and
`tools/traderton-read.ts`). The original C1/C3 "tools disappear/reappear from a
snapshot" framing did not match the design and was replaced with the real
per-call behavior below.

**Method:** a read-only signed probe (`get_price`, 005 canonical string) run from
inside `herobids-worker-1` against the live boundary — the same network path and
auth the worker uses. The boundary was stopped and restarted on the Traderton
host (operator-approved; ~30s outage, 17:20:05→17:20:44 UTC).

| # | Check | Result | Evidence (2026-10-01) |
|---|---|---|---|
| C-base | Signed call reaches boundary (auth + routing work) | ✅ PASS | Boundary UP: HTTP 200, ~118ms round-trip; call passed HMAC auth, envelope validation, and reached `get_price` tool-level schema validation. |
| C2 | Call while boundary DOWN fails closed, no crash/hang | ✅ PASS | Boundary stopped (Caddy → HTTP 502). Probe returned HTTP 502 in **119ms** (fast fail, no stall) → client maps to retryable `transport_error`. `herobids-worker-1` stayed "Up 4 days"; no error/stack in worker logs. |
| C3 | Boundary recovers after restart | ✅ PASS | `docker start staging-boundary-1` → `/health/ready` returned 200 after **~8–9s**; next signed call HTTP 200 (~94ms). |
| C4 | Idempotent retry with the same key is consistent | ✅ PASS | Re-issuing the same idempotency key after recovery returned the **identical outcome** (same `requestId`/`correlationId`, same deterministic tool-validation result); no divergence. (Note: tested on a read tool — a write-path idempotency assertion belongs with Step 16.) |
| C5 | HMAC enforced over the live HTTPS wire | ✅ PASS | Unsigned `POST /internal/v1/tools:invoke` → `authentication.invalid_caller` ("missing X-Traderton-Consumer-Id"). |

Hosts/keys used: herobids `138.199.172.202` (`~/.ssh/herobids_deploy_key`),
traderton `2.28.19.89` (`~/.ssh/traderton_deploy_staging_key`). The probe and all
temp files were removed from both hosts and the container after the run. Boundary
confirmed healthy (HTTP 200) at end.

> Caveat: C4 exercised a **read** tool, so it proves transport/response
> idempotency, not a durable write dedup. The write-path idempotency guarantee
> (same key → one durable `submit_decision`) is the Step 16 obligation.

## D. Metrics-based readiness items — N/A (no instrumentation exists)

The generic readiness spec (`014-…`) asks for a latency budget, shadow-mode
equivalence rate, load-test throughput/latency, and boundary-overhead
histograms. **None of these are obtainable today** because the codebase has no
metrics system (see below). They are not "failed" and not "deferred-but-ready" —
they would each require **building instrumentation first**, which is new work,
not verification.

| # | Spec item | Why N/A | To make it obtainable |
|---|---|---|---|
| D1 | p50/p95/p99/max latency per tool | No code times the dispatch→result round-trip. | Add timing around the boundary client call + an export/log of the duration. |
| D2 | Boundary overhead (excl. downstream) | No downstream-vs-boundary split is recorded. | Backend must report its own execution time; platform subtracts. |
| D3 | Throughput (req/s), error-rate-by-code histograms | No counters/metrics endpoint. | Add a metrics layer (none chosen — no prom-client/otel/statsd in repo). |
| D4 | Shadow-mode equivalence rate (in-process vs boundary) | The in-process trading path has been removed in favour of the boundary (trading calls fail-closed without it); there is no dual path to diff against on staging. | Full differential belongs to roadmap Step 16 against the pinned pre-removal oracle SHA `1f6978d740d45e466cf4149617b8afc1c721e751`, not Phase 1. |
| D5 | Load test metrics | No metrics to capture during load; load without measurement proves nothing. | Depends on D1–D3 first. |

### Why there are no latency/throughput numbers (code evidence, 2026-10-01)

- No `prom-client`, `prometheus`, `OpenTelemetry`/`otel`, `statsd`, `/metrics`
  endpoint, or histogram instrumentation anywhere in the app packages.
- `config/default.yaml` has **no** `externalBackends.latencyTargets.*` or
  `externalBackends.requestTimeoutMs` keys — those paths exist only in the draft
  readiness spec, never implemented.
- The Traderton client (`packages/domain/src/traderton/client.ts`) uses
  `Date.now()` only for deadline/timeout arithmetic — it does not record call
  duration.
- What *does* exist: pino structured logging (`createLogger`) across worker/API,
  a worker health-check loop (`worker.agents.healthCheckIntervalMs`), the
  boundary `/health/ready` endpoint, and typed failure codes
  (`precondition.not_ready`, `already_resolved`, double-execution guard in
  `approval-service`). Readiness here is therefore **behavioral/observational**
  (§C), not metric-based.

## E. Rollback — recorded, not required (pre-launch)

The generic spec requires an operator-config switch back to the in-process path
with no code/migration. Pre-launch this is **intentionally not satisfied and not
required**: the in-process trading path has been removed, there are no users or
durable data, and the accepted recovery is teardown + rebuild (reprovision
runbook below). Re-evaluate this item before public launch.

## Verdict

- **Phase 1 is operationally proven at the "deployed, integrated, healthy"
  level** (A + B): both stacks live and independent, boundary reachable from the
  real caller over HTTPS, config wired, release refs pinned.
- **Behavioral readiness verified live** (§C, 2026-10-01): signed calls work over
  the real wire; a boundary outage fails closed fast with no worker crash; the
  boundary recovers in ~8–9s; idempotent retry is consistent; HMAC is enforced.
  These are the resilience properties the system is actually designed to provide
  (per-call fail-closed, not snapshot health-gating).
- **Not applicable without new work:** all metric-based items (§D) — the system
  emits no metrics; latency/throughput numbers are not obtainable until
  instrumentation is added. Known gap, deferred to Step 16 / a future
  observability task, not a Phase 1 blocker given no launch.
- **Remaining real obligation for full cutover (Step 16):** the write-path
  shadow/differential + idempotency-on-writes against the pinned pre-removal
  oracle SHA. Everything achievable pre-launch without new instrumentation is
  now done.

## References

- Reprovision runbook: `infra/hetzner/docs/staging-reprovision-runbook.md`
- Status report: `docs/features/2026/10/001-implementation-status-report.md`
- Roadmap: `docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md`
- Readiness spec: `docs/features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md`
