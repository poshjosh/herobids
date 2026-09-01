# Browser-Pool Autoscaling

**Status:** Draft
**Created:** 2026-08-31
**Area:** Infrastructure, browser-pool, Nomad orchestration

---

## Problem Statement

The browser-pool service (`ghcr.io/browserless/chromium`) currently runs as a single Nomad job instance with `count = 1` and `MAX_CONCURRENT_SESSIONS = 2`. When both sessions are occupied, additional requests queue (up to `QUEUE_LENGTH = 10`), and beyond that Browserless returns HTTP 429. The `BrowserlessAdapter` maps this to `browser_pool.queue_full`, and the agent receives an error with no automatic recovery.

Today, browser-pool capacity is adjusted manually by editing `browser-pool.nomad.hcl` and re-deploying the job. We already have browser-pool observability in the worker/admin surfaces, but we do not have a dedicated browser-pool autoscale loop that reacts to demand spikes or browser-pool-specific failures.

As agent usage of `browse_interactive` grows, this becomes a bottleneck. A single slow or stuck browser session can consume roughly half of the pool's effective capacity.

### Why not clone the agent-node autoscaler?

The agent-node autoscaler and the browser-pool autoscaler operate on different things.

The agent-node autoscaler provisions and destroys Hetzner servers via Terraform. That is a server-supply problem: it has to deal with remote state, locking, node lifecycle, drain safety, and multi-minute provisioning delays. The browser-pool autoscaler is primarily an in-cluster workload-supply problem: it changes the count of an existing Nomad job so Nomad can place more browser allocations on agent-node servers that already exist.

That difference is what justifies a different design. Browser-pool scale-out should first be a fast Nomad-level action. Only when Nomad cannot place the additional browser allocations should the heavier agent-node autoscaler wake up and add more servers.

## Goals

1. Automatically scale browser-pool instances up when utilization is high or requests are queuing.
2. Compose with the existing agent-node autoscaler as a second-level fallback when Nomad cannot place more browser-pool instances.
3. Respect configurable min/max bounds and cooldowns.
4. Distribute new browser sessions across browser-pool instances in a way that keeps each session pinned to one concrete Browserless backend.
5. Reuse existing infrastructure where it genuinely fits (`scale-common.sh`, `alert-common.sh`, Nomad ACL token, systemd patterns).
6. Preserve runtime browser-pool capacity across deploys instead of accepting a reset to `count = 1`.

## Non-Goals

- Vertical scaling (changing `MAX_CONCURRENT_SESSIONS` per instance at runtime). This requires restarting the Browserless container and is better handled by operator config changes.
- Replacing the agent-node autoscaler. The two systems are complementary.
- Automatic browser-pool scale-in in the initial rollout. We will not remove browser-pool instances automatically until we can prove that doing so will not kill live sessions.
- Proxy-based or load-balancer-based browser session routing in v1. The initial design keeps browser instance selection in application code.
- Multi-datacenter or cross-region browser-pool placement.
- Browser-pool authentication (Browserless `TOKEN` env var). This is orthogonal to autoscaling and can be added independently.

## Design Decisions

### D1. Use a two-level scaling model

**Decision:** Browser-pool autoscaling is a two-level system.

- **Level 1:** Scale the browser-pool Nomad job on existing agent-node servers.
- **Level 2:** If Nomad cannot place the new browser-pool allocations, rely on the existing placement-failure watcher to trigger agent-node scale-out.

**Rationale:** Browser-pool instances run on agent-node servers. The fastest response is therefore to add more browser allocations on capacity that already exists. Only when that capacity is exhausted do we need to provision more machines.

### D2. Scale browser-pool allocations via the Nomad job scale API, not Terraform

**Decision:** Use `POST /v1/job/browser-pool/scale` to change the browser task-group count.

**Rationale:** This is the native Nomad mechanism for adjusting workload count inside the cluster. It completes in seconds, does not require Terraform state, and avoids reusing agent-node server lifecycle machinery for a problem that is usually just a scheduler mutation.

The `POST /v1/job/{job_id}/scale` endpoint accepts:

```json
{
  "Count": 3,
  "Target": { "Group": "browser" },
  "Message": "autoscale: utilization 85% > threshold 70%"
}
```

### D3. Use Browserless `/pressure` as the primary metric source, with a fallback path

**Decision:** Poll each Browserless instance's `GET /pressure` endpoint for real-time load data. If it is unavailable, fall back to `GET /config` plus `GET /sessions`.

**Rationale:** `/pressure` gives the best live signal for scale-out: `running`, `maxConcurrent`, `queued`, and `recentlyRejected`.

The script will treat `recentlyRejected` as a recent-window signal, not as a durable cumulative counter. It is useful as a scale-out hint, but it should not be treated as an accounting metric.

If `/pressure` is unavailable on the deployed image, the fallback path still supports utilization-based scale-out. In fallback mode, `queued` and `recentlyRejected` are unavailable.

### D4. Do browser instance selection in application code, per new session

**Decision:** Do not rely on a generic proxy or a one-time startup-time URL lookup to spread browser traffic. For each new browser session, the worker selects one concrete Browserless instance and uses that same instance for both session acquisition and the subsequent CDP WebSocket connection.

**Rationale:** Browserless sessions are a two-step flow: acquire the session over HTTP, then continue it over WebSocket. Generic round-robin in front of multiple Browserless instances is risky because the HTTP request and the WebSocket upgrade can land on different backends. Startup-time randomization is also insufficient because it pins an agent process to one chosen endpoint until restart.

The v1 rollout should therefore keep local/dev static URLs, but in Nomad it should resolve all healthy browser-pool instances and choose a concrete target per new session.

### D5. Phase 1 is scale-out only

**Decision:** The initial browser-pool autoscaler automatically scales out but does not automatically scale in.

**Rationale:** Browser-pool scale-out is cheap and safe compared to scale-in. Scale-in is not trivial: reducing Nomad job count can terminate a Browserless allocation that still has live CDP sessions. We should not ship automatic scale-in until we have session-aware removal semantics and validation to prove that an instance can be removed safely.

### D6. Reuse the existing shell autoscale infrastructure, including locking and alerting

**Decision:** Reuse `scale-common.sh` and `alert-common.sh`, and take a dedicated browser-pool lock file.

**Rationale:** We still want the lightweight script shape and the existing alerting pipeline, but there is no reason to skip locking entirely. A dedicated lock avoids overlapping timer runs and serializes local state-file updates.

### D7. Preserve runtime counts on deploy

**Decision:** Re-deploying the browser-pool Nomad job must preserve the existing task-group count instead of resetting it to the static `count = 1` in HCL.

**Rationale:** The current "accept the brief dip" approach creates avoidable capacity loss during deploys. The deploy path should preserve runtime counts when re-registering the job, rather than relying on the autoscaler to repair capacity after the fact.

Implementation preference:

1. Use the Nomad CLI preserve-counts path first, because it stays closest to the existing deploy workflow and is easier for operators to understand and debug.
2. Fall back to direct API submission only if the CLI path cannot reliably preserve the browser task-group count in the real deploy flow.

We are not leaving this choice entirely to the implementer. The requirement is fixed, and the order of preference is fixed.

### D8. Add a `scaling` block as a scheduler guardrail, but render bounds from one place

**Decision:** Add a `scaling` block to `browser-pool.nomad.hcl`, but ensure the job-spec bounds and autoscaler bounds come from the same Terraform variables.

**Rationale:** The `scaling` block is still useful as a guardrail and for operator visibility. The mistake to avoid is manual dual-entry of the same bounds in two different places.

```hcl
scaling {
  min     = 1
  max     = 5
  enabled = true

  policy {}
}
```

---

## Implementation

### Phase 1: Scale-out only + deploy-safe changes

**Effort:** ~1 day
**Risk:** Low to medium — additive infra change plus a small worker-side routing change.

#### Tasks

**1.1 — Add `scaling` block to `browser-pool.nomad.hcl`**

Add a `scaling` block to the `browser` task group. Its `min`/`max` values must be rendered from the same Terraform variables the autoscale script reads.

**1.2 — Create `browser-pool-autoscale.sh` for scale-out only**

New file: `infra/hetzner/scripts/browser-pool-autoscale.sh`

The script sources `scale-common.sh` and `alert-common.sh` and performs scale-out only.

Logic flow:

```
1.  Read config from env vars (enabled, min/max, scale-out threshold, cooldown)
2.  Acquire a dedicated browser-pool autoscale lock
3.  GET /v1/job/browser-pool and read the count for task group "browser"
4.  GET /v1/service/browser-pool and list all registered instance addresses
5.  For each instance address:
      GET http://<address>/pressure
      (If /pressure is unavailable, fall back to /config + /sessions)
6.  Aggregate across all instances:
      total_running
      total_capacity
      total_queued
      total_recently_rejected
      utilization_pct = (total_running * 100) / total_capacity
7.  If utilization is above threshold OR queued > 0 OR recentlyRejected > 0:
      if current_count < MAX_INSTANCES and cooldown expired:
        POST /v1/job/browser-pool/scale with Count = current_count + 1
        touch cooldown file
        clear failure count
      else:
        log why no scale happened
8.  On failure: track via alert_failure and send alerts if threshold crossed
```

Exit codes:

- 0: success (scaled or no action needed)
- 1: configuration or runtime error
- 2: feature disabled (`BROWSER_POOL_AUTOSCALE_ENABLED != true`)

Supports `--dry-run` and `--help`.

**1.3 — Add Terraform variables**

Add only the variables required for the scale-out-first rollout:

| Variable | Type | Default | Description |
|---|---|---|---|
| `browser_pool_autoscale_enabled` | bool | false | Feature flag |
| `browser_pool_min_instances` | number | 1 | Minimum task group count |
| `browser_pool_max_instances` | number | 5 | Maximum task group count |
| `browser_pool_scale_out_utilization_pct` | number | 70 | Scale out above this utilization % |
| `browser_pool_cooldown_seconds` | number | 120 | Minimum seconds between scale events |

Stage scale-in-specific variables for a later phase rather than shipping them now.

**1.4 — Add systemd units to `cloud-init.yaml`**

Add `browser-pool-autoscale.service` and `browser-pool-autoscale.timer`, following the existing autoscale unit pattern.

Key differences from the previous draft:

- Include a dedicated lock-file path.
- Do not include scale-in-only environment variables yet.
- Reuse `EnvironmentFile=-/etc/herobids/autoscale.env` for `NOMAD_TOKEN`.

**1.5 — Implement per-session browser instance selection in the worker**

Replace the previous plan to randomize `NomadServiceRegistry.resolve()` at startup.

Instead:

- In Docker/local dev, keep using the static browser URL.
- In Nomad, resolve all healthy browser-pool instances for each new browser session.
- Choose one concrete instance for that session.
- Use that same instance for both `PUT /json/new` and the returned CDP WebSocket URL.

This is the minimum change that actually spreads browser load without relying on proxy stickiness.

**1.6 — Preserve browser-pool count on deploy**

Update the deploy path for Nomad infrastructure jobs so re-registering `browser-pool.nomad.hcl` preserves the current task-group count instead of forcing the static count from HCL.

Implementation order:

1. First try the Nomad CLI preserve-counts path.
2. Only use direct API submission if the CLI path cannot reliably preserve the browser task-group count in the real deploy flow.

The requirement is fixed: deploys must not drop runtime browser-pool capacity.

**1.7 — Update operator docs**

Update `infra/hetzner/README.md` to document:

- The two-level scaling model.
- Scale-out-only initial rollout.
- Browserless `/pressure` metrics and fallback behavior.
- Per-session instance selection in the worker.
- Manual override commands (`--dry-run`, `--help`).
- Systemd unit names, lock file, and log locations.
- Count-preserving deploy behavior.

#### Files Modified

| File | Changes |
|---|---|
| `infra/nomad/browser-pool.nomad.hcl` | Add `scaling` block |
| `infra/hetzner/scripts/browser-pool-autoscale.sh` | New file — scale-out-only autoscale script |
| `infra/hetzner/variables.tf` | Add scale-out variables |
| `infra/hetzner/staging.tfvars` | Add browser-pool autoscale config |
| `infra/hetzner/production.tfvars` | Add browser-pool autoscale config |
| `infra/hetzner/cloud-init.yaml` | Add browser-pool autoscale service/timer |
| `apps/worker/src/index.ts` | Remove one-time browser-pool pinning in Nomad path |
| `apps/worker/src/agents/service-registry.ts` | Support resolving multiple browser-pool instances |
| `packages/venues/src/browserless-adapter.ts` | Choose a concrete instance per new browser session |
| `infra/hetzner/scripts/push.sh` | Preserve browser-pool counts on Nomad job re-submit |
| `infra/hetzner/README.md` | Document browser-pool autoscaling |

#### Acceptance Criteria

- `browser-pool-autoscale.sh --dry-run` runs without error on a machine with `curl` and `jq`.
- With `BROWSER_POOL_AUTOSCALE_ENABLED=false`, the script exits 2 immediately.
- With `--dry-run`, the script logs the utilization snapshot, the scale decision, and what it would do without calling the Nomad scale API.
- The script reads the `browser` task-group count by name, not by array index.
- `browser-pool.nomad.hcl` validates with the added `scaling` block.
- On Nomad, new browser sessions are distributed across multiple browser-pool instances by choosing a concrete instance per session.
- Re-deploying the browser-pool job preserves the runtime task-group count.
- `pnpm lint` passes.

### Phase 2: Validation in staging

**Effort:** ~0.5 day
**Risk:** Low — staging only, feature-flagged.

#### Tasks

**2.1 — Deploy to staging**

Deploy the scale-out loop, the worker-side per-session selection, and the deploy-path count-preservation change.

**2.2 — Verify `/pressure` availability**

Confirm the deployed Browserless image exposes `/pressure`. If not, verify the fallback path (`/config` + `/sessions`) works correctly.

**2.3 — Test scale-out**

Saturate the browser-pool with concurrent browser requests. Verify:

- The autoscaler detects high utilization or queue pressure.
- It scales from count=1 to count=2 via the Nomad scale API.
- The new instance registers in the Nomad service catalog.
- New browser sessions are distributed across concrete browser-pool instances.

**2.4 — Test composition with the agent-node autoscaler**

Set `BROWSER_POOL_MAX_INSTANCES` high enough that Nomad cannot place all desired browser-pool instances. Verify:

- The browser-pool autoscaler increases the desired count.
- Nomad marks the evaluation as blocked.
- The placement-failure watcher detects it and triggers agent-node scale-out.

**2.5 — Test alerting**

Simulate a failure (for example, stop Nomad) and verify the browser-pool autoscale alert pipeline fires after the configured failure threshold.

#### Acceptance Criteria

- Scale-out works end-to-end on staging.
- New sessions spread across multiple browser-pool instances in Nomad.
- Placement failures trigger the existing agent-node autoscaler.
- Alerts fire on repeated failures.

### Phase 3: Safe scale-in design

**Effort:** ~0.5 day design + validation
**Risk:** Medium — scale-in can terminate live sessions if done incorrectly.

#### Tasks

**3.1 — Define session-aware scale-in semantics**

Choose a scale-in strategy that proves an instance is safe to remove before reducing count. Examples:

- only scale in when a chosen instance reports zero live sessions,
- add an operator or scheduler drain step for browser allocations,
- or add explicit worker/browser-pool coordination for shutdown.

**3.2 — Add conservative hysteresis**

Only after safe removal semantics exist, add scale-in thresholds, streak counters, and validation.

**3.3 — Validate end to end in staging**

Verify a browser-pool instance can be removed without killing a live CDP session.

#### Acceptance Criteria

- Automatic scale-in is not enabled until staging proves safe removal.
- The final scale-in logic is session-aware, not just utilization-aware.

### Phase 4: Production rollout

**Effort:** ~0.5 day
**Risk:** Low for scale-out-only rollout; revisit risk before enabling automatic scale-in.

#### Tasks

**4.1 — Enable scale-out in production**

Set `browser_pool_autoscale_enabled = true` in `production.tfvars` with conservative values:

- `browser_pool_max_instances = 3`
- `browser_pool_scale_out_utilization_pct = 70`
- `browser_pool_cooldown_seconds = 300`

**4.2 — Monitor**

Watch `journalctl -u browser-pool-autoscale` and `/var/log/browser-pool-autoscale.log` for the first few days. Verify scale-out events are reasonable and that deploys preserve count.

**4.3 — Tune thresholds**

Adjust thresholds based on observed production traffic patterns.

**4.4 — Enable scale-in only after Phase 3 is complete**

Automatic browser-pool scale-in is a separate rollout decision, not part of the initial enablement.

---

## State Files

The scale-out loop uses dedicated browser-pool state files in `/var/run/`:

| File | Purpose |
|---|---|
| `/var/run/browser-pool-autoscale.lock` | Serializes overlapping timer runs and local state updates |
| `/var/run/browser-pool-autoscale-last-scale` | Unix timestamp of last scale event (cooldown) |
| `/var/run/browser-pool-autoscale-failure-count` | Consecutive failure count (alert tracking, via `alert-common.sh`) |
| `/var/run/browser-pool-autoscale-last-alert` | Alert rate-limit timestamp |

The browser-pool autoscaler does not need Terraform state or an S3 backend because it does not provision servers directly. It still uses a lock file because it mutates local cooldown and alert state.

---

## Reused Infrastructure

| Component | What it provides |
|---|---|
| `scale-common.sh` | `log`, `die`, `nomad_api`, cooldown helpers, dry-run helpers, lock helpers |
| `alert-common.sh` | `alert_failure`, `clear_failure_count`, `send_alert`, `send_recovery_alert` |
| `/etc/herobids/autoscale.env` | `NOMAD_TOKEN` for authenticated Nomad API calls |
| `cloud-init.yaml` template flow | Terraform variables -> cloud-init -> systemd environment |
| `nomad-placement-failure-watcher` | Level-2 fallback: blocked browser-pool placements -> agent-node scale-out |

---

## Resolved Questions

### RQ1. Does the deployed Browserless image expose `/pressure`?

**Status:** Resolved enough for implementation — build the fallback path regardless.

We will attempt `/pressure` first and cache availability per instance. If it returns 404 or otherwise fails, the script falls back to `GET /config` plus `GET /sessions`.

When `/pressure` is available, treat `recentlyRejected` as a recent-window scale-out signal, not as an all-time counter.

### RQ2. Worker-side instance resolution — single vs multiple addresses

**Status:** Resolved — do per-session concrete instance selection in application code.

The earlier idea of randomizing `NomadServiceRegistry.resolve()` is not sufficient because browser sessions are created over HTTP and then continued over WebSocket. The worker must choose one concrete Browserless instance per new session and keep that session pinned to it.

### RQ3. Nomad job re-deploy resets count

**Status:** Resolved — do not accept the dip.

The deploy path must preserve runtime task-group counts when re-registering the job. A deploy should not intentionally reduce browser-pool capacity and wait for the autoscaler to repair it.

### RQ4. Browser-pool autoscaling composes with agent-node autoscaling

**Status:** Resolved — yes, as a two-level model.

Browser-pool autoscaling is level 1: add browser allocations on existing agent-node servers. Agent-node autoscaling is level 2: add more servers when Nomad cannot place those allocations.
