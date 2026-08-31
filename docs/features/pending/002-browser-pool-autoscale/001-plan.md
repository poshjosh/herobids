# Browser-Pool Autoscaling

**Status:** Draft
**Created:** 2026-08-31
**Area:** Infrastructure, browser-pool, Nomad orchestration

---

## Problem Statement

The browser-pool service (`ghcr.io/browserless/chromium`) runs as a single Nomad job instance with `count = 1` and `MAX_CONCURRENT_SESSIONS = 2`. When all sessions are occupied, additional requests queue (up to `QUEUE_LENGTH = 10`), and beyond that Browserless returns HTTP 429. The `BrowserlessAdapter` maps this to `browser_pool.queue_full`, and the agent receives an error with no automatic recovery.

Scaling is entirely manual: an operator edits `browser-pool.nomad.hcl` (bumping `count` or `MAX_CONCURRENT_SESSIONS`) and re-deploys the Nomad job. There is no monitoring, no alerting, and no automatic response to demand changes.

As agent usage of `browse_interactive` grows, this becomes a bottleneck. A single stuck or slow browsing session consumes 50% of the pool's capacity.

### Why not clone the agent-node autoscaler?

The agent-node autoscaler provisions Hetzner servers via Terraform — a heavyweight, multi-minute operation that justifies its complexity (5+ shell scripts, S3 state backend, flock serialization, cooldown files, systemd timers). Browser-pool scaling is fundamentally different: it changes the `count` on an existing Nomad job, which takes seconds via the Nomad API. The infrastructure complexity of the agent-node approach would be disproportionate.

## Goals

1. Automatically scale browser-pool instances up when utilization is high or requests are queuing.
2. Automatically scale browser-pool instances down when utilization is consistently low.
3. Respect configurable min/max bounds and cooldowns.
4. Compose with the existing agent-node autoscaler — if browser-pool needs more instances than Nomad agent nodes can host, the placement-failure watcher triggers agent-node scale-out.
5. Reuse existing infrastructure (scale-common.sh, alert-common.sh, Nomad ACL token, systemd patterns).

## Non-Goals

- Vertical scaling (changing `MAX_CONCURRENT_SESSIONS` per instance at runtime). This requires restarting the Browserless container and is better handled by operator config changes.
- Replacing the agent-node autoscaler. The two systems are complementary.
- Multi-datacenter or cross-region browser-pool placement.
- Browser-pool authentication (Browserless `TOKEN` env var). This is orthogonal to autoscaling and can be added independently.

## Design Decisions

### D1. Scale via Nomad job scale API, not Terraform

**Decision:** Use `POST /v1/job/browser-pool/scale` to change the task group count.

**Rationale:** This is the native Nomad mechanism for adjusting task group count. It takes seconds (vs minutes for Terraform + Hetzner provisioning), requires no Terraform state, no S3 backend, and no flock serialization against the agent-node autoscaler's Terraform operations. The Nomad service catalog automatically registers/deregisters instances.

The `POST /v1/job/{job_id}/scale` endpoint accepts:
```json
{
  "Count": 3,
  "Target": { "Group": "browser" },
  "Message": "autoscale: utilization 85% > threshold 70%"
}
```

This means the static `count = 1` in `browser-pool.nomad.hcl` is only the initial deployment value. Runtime scaling via the API overrides it until the next `nomad job run` re-deploys the HCL file. A re-deploy resets the count to 1, but the autoscaler recovers within 60-120 seconds (see RQ3).

### D2. Use Browserless `/pressure` endpoint as the metric source

**Decision:** Poll each Browserless instance's `GET /pressure` endpoint for real-time utilization data.

**Rationale:** The open-source Browserless image exposes `/pressure` which returns:
```json
{
  "pressure": {
    "cpu": 45,
    "memory": 62,
    "isAvailable": true,
    "maxConcurrent": 2,
    "maxQueued": 10,
    "running": 1,
    "queued": 0,
    "reason": "",
    "recentlyRejected": 0,
    "date": 1711468800000,
    "message": ""
  }
}
```

This gives us direct, authoritative metrics: `running` (active sessions), `maxConcurrent` (capacity), `queued` (backpressure), and `recentlyRejected` (demand overflow). No need to infer load from Nomad memory allocation like the agent-node autoscaler does.

**Fallback if `/pressure` is unavailable on the open-source image:** The open-source image docs list `/pressure` as a management endpoint. If testing reveals it's enterprise-only, fall back to `GET /config` (returns `maxConcurrent`) combined with `GET /sessions` (returns active session list). The script should attempt `/pressure` first on each instance and cache whether it's available, so the fallback path doesn't add latency on every poll. If the fallback is needed, `queued` and `recentlyRejected` won't be available — scale-out triggers only on utilization % (session count / max concurrent). This is less responsive but still functional. See Resolved Question RQ1.

### D3. Single bidirectional script

**Decision:** One script (`browser-pool-autoscale.sh`) handles both scale-out and scale-in.

**Rationale:** The agent-node autoscaler separates scale-out (every 60s) from scale-in (nightly at 3 AM) because scale-in requires draining nodes, waiting for allocations to migrate, and running Terraform — operations that are slow and risky. Browser-pool scale-in is trivial: reduce the Nomad job count, and Nomad gracefully stops the excess allocation (Browserless sessions drain naturally via `TIMEOUT`). A single script with bidirectional logic is simpler and reduces the number of systemd units.

### D4. Scale-in hysteresis via streak counter

**Decision:** Require N consecutive low-utilization checks before scaling in.

**Rationale:** Scale-out should be reactive (respond immediately to demand). Scale-in should be conservative (avoid flapping when utilization oscillates around the threshold). A streak counter — reset on any check where utilization exceeds the low watermark — provides this asymmetry without a separate timer or state machine.

The streak counter is stored in a single file (`/var/run/browser-pool-autoscale-low-streak`). Reset to 0 on any scale-out or when utilization rises above the low watermark.

### D5. Instance discovery via Nomad service catalog

**Decision:** Resolve browser-pool instance addresses by querying `GET /v1/service/browser-pool` from the Nomad service catalog, not from static config.

**Rationale:** As the job scales, new instances register and removed instances deregister in the Nomad service catalog automatically. The script needs to poll `/pressure` on every running instance to compute aggregate utilization. Querying the service catalog gives the current, accurate set of instance addresses without maintaining a separate registry.

### D6. Compose with agent-node autoscaler via placement failures

**Decision:** No direct integration between browser-pool autoscaling and agent-node autoscaling.

**Rationale:** When the browser-pool autoscaler increases `count` beyond what current Nomad agent nodes can host, Nomad marks the evaluation as blocked (resource exhaustion). The existing placement-failure watcher (`check-placement-failures.sh`) detects this and triggers agent-node scale-out. The two systems compose through Nomad's native scheduling — no coupling needed.

### D7. Add a `scaling` block to the Nomad job

**Decision:** Add a `scaling` block to `browser-pool.nomad.hcl` to declare min/max bounds in the job spec itself.

**Rationale:** Nomad's `scaling` block provides declarative min/max enforcement at the scheduler level, preventing the API from setting count outside bounds even if the script has a bug. It also makes the scaling policy visible in `nomad job inspect`.

```hcl
scaling {
  min     = 1
  max     = 5
  enabled = true

  policy {}  # empty — we use an external script, not Nomad Autoscaler
}
```

The script reads min/max from its environment variables (injected via systemd), not from the job spec. The `scaling` block is a safety net, not the source of truth. The operator must keep both in sync — a mismatch means the tighter bound wins (which is safe).

---

## Implementation

### Phase 1: Autoscale script + systemd deployment

**Effort:** ~1 day
**Risk:** Low — additive infrastructure change. Browser-pool continues to work if the autoscaler fails (it just won't scale).

#### Tasks

**1.1 — Add `scaling` block to `browser-pool.nomad.hcl`**

Add a `scaling` block to the `browser` task group:

```hcl
scaling {
  min     = 1
  max     = 5
  enabled = true

  policy {}
}
```

This is purely declarative — it doesn't change runtime behavior until the script starts scaling.

**1.2 — Create `browser-pool-autoscale.sh`**

New file: `infra/hetzner/scripts/browser-pool-autoscale.sh`

The script sources `scale-common.sh` (reusing `log`, `die`, `nomad_api`, cooldown helpers) and `alert-common.sh` (reusing failure tracking and alerting).

Logic flow:

```
1.  Read config from env vars (thresholds, min/max, cooldown, streak threshold)
2.  GET /v1/job/browser-pool → extract current count from .TaskGroups[0].Count
3.  GET /v1/service/browser-pool → list all registered instance addresses
4.  For each instance address:
      GET http://<address>/pressure → extract running, maxConcurrent, queued, recentlyRejected
      (If /pressure returns 404, fall back to /config + /sessions — see D2 / RQ1)
5.  Aggregate across all instances:
      total_running    = sum of running
      total_capacity   = sum of maxConcurrent
      total_queued     = sum of queued
      total_rejected   = sum of recentlyRejected
      utilization_pct  = (total_running * 100) / total_capacity  (0 if total_capacity == 0)
6.  SCALE-OUT check:
      if utilization_pct > SCALE_OUT_THRESHOLD  OR  total_queued > 0  OR  total_rejected > 0:
        if current_count < MAX_INSTANCES:
          if cooldown expired:
            new_count = min(current_count + 1, MAX_INSTANCES)
            POST /v1/job/browser-pool/scale { Count: new_count, Target: { Group: "browser" }, Message: "..." }
            touch cooldown file
            reset low-streak counter to 0
            clear failure count
          else:
            log "cooldown active"
        else:
            log "already at max"
7.  SCALE-IN check:
      elif utilization_pct < SCALE_IN_THRESHOLD  AND  total_queued == 0  AND  total_rejected == 0:
        increment low-streak counter
        if streak >= STABLE_CHECKS:
          if current_count > MIN_INSTANCES:
            if cooldown expired:
              new_count = max(current_count - 1, MIN_INSTANCES)
              POST /v1/job/browser-pool/scale { Count: new_count, Target: { Group: "browser" }, Message: "..." }
              touch cooldown file
              reset low-streak counter to 0
              clear failure count
            else:
              log "cooldown active"
          else:
            log "already at min"
      else:
        reset low-streak counter to 0  (utilization in normal range)
8.  On any failure: track via alert_failure; send alert if threshold crossed
```

Exit codes:
- 0: success (scaled or no action needed)
- 1: configuration or runtime error
- 2: feature disabled (`BROWSER_POOL_AUTOSCALE_ENABLED != true`)

Supports `--dry-run` and `--help` flags (same pattern as existing scripts).

**1.3 — Add Terraform variables**

New variables in `infra/hetzner/variables.tf`:

| Variable | Type | Default | Description |
|---|---|---|---|
| `browser_pool_autoscale_enabled` | bool | false | Feature flag |
| `browser_pool_min_instances` | number | 1 | Minimum task group count |
| `browser_pool_max_instances` | number | 5 | Maximum task group count |
| `browser_pool_scale_out_utilization_pct` | number | 70 | Scale out above this utilization % |
| `browser_pool_scale_in_utilization_pct` | number | 20 | Scale in below this utilization % |
| `browser_pool_scale_in_stable_checks` | number | 5 | Consecutive low-util checks before scale-in |
| `browser_pool_cooldown_seconds` | number | 120 | Minimum seconds between scale events |

Add corresponding entries to `staging.tfvars` (enabled, tighter thresholds for testing) and `production.tfvars` (disabled initially, conservative thresholds).

**1.4 — Add systemd units to `cloud-init.yaml`**

Two new units, following the exact pattern of the existing autoscale units:

`browser-pool-autoscale.service`:
```ini
[Unit]
Description=Browser-Pool Autoscale Loop
Wants=network-online.target nomad.service
After=network-online.target nomad.service
Requires=nomad.service

[Service]
Type=oneshot
WorkingDirectory=/opt/herobids/infra/hetzner
ExecStart=/opt/herobids/infra/hetzner/scripts/browser-pool-autoscale.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=browser-pool-autoscale

Environment=NOMAD_ADDR=http://127.0.0.1:4646
Environment=BROWSER_POOL_AUTOSCALE_ENABLED=${browser_pool_autoscale_enabled}
Environment=BROWSER_POOL_MIN_INSTANCES=${browser_pool_min_instances}
Environment=BROWSER_POOL_MAX_INSTANCES=${browser_pool_max_instances}
Environment=BROWSER_POOL_SCALE_OUT_UTILIZATION_PCT=${browser_pool_scale_out_utilization_pct}
Environment=BROWSER_POOL_SCALE_IN_UTILIZATION_PCT=${browser_pool_scale_in_utilization_pct}
Environment=BROWSER_POOL_SCALE_IN_STABLE_CHECKS=${browser_pool_scale_in_stable_checks}
Environment=BROWSER_POOL_COOLDOWN_SECONDS=${browser_pool_cooldown_seconds}
Environment=BROWSER_POOL_AUTOSCALE_LOG_FILE=/var/log/browser-pool-autoscale.log
Environment=BROWSER_POOL_AUTOSCALE_COOLDOWN_FILE=/var/run/browser-pool-autoscale-last-scale
Environment=BROWSER_POOL_AUTOSCALE_LOW_STREAK_FILE=/var/run/browser-pool-autoscale-low-streak
Environment=HEROBIDS_ENV=${environment}

# Alerting (reuse existing alert config)
Environment=NOMAD_AUTOSCALE_FAILURE_COUNT_FILE=/var/run/browser-pool-autoscale-failure-count
Environment=NOMAD_AUTOSCALE_LAST_ALERT_FILE=/var/run/browser-pool-autoscale-last-alert
Environment=ALERT_FAILURE_THRESHOLD=${alert_failure_threshold}
Environment=ALERT_RATE_LIMIT_SECONDS=${alert_rate_limit_seconds}
Environment=ALERT_SEND_RECOVERY=${alert_send_recovery}
Environment=ALERT_SMTP_HOST=${alert_smtp_host}
Environment=ALERT_SMTP_PORT=${alert_smtp_port}
Environment=ALERT_SMTP_USE_TLS=${alert_smtp_use_tls}
Environment=ALERT_FROM=${alert_from}
Environment=ALERT_TO=${alert_to}
Environment=ALERT_SMTP_USER=${alert_smtp_user}
Environment=ALERT_SMTP_PASS=${alert_smtp_pass}

EnvironmentFile=-/etc/herobids/autoscale.env

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/run /var/log

[Install]
WantedBy=multi-user.target
```

`browser-pool-autoscale.timer`:
```ini
[Unit]
Description=Browser-Pool Autoscale Timer

[Timer]
OnUnitActiveSec=60s
OnBootSec=180s
RandomizedDelaySec=15s
Unit=browser-pool-autoscale.service

[Install]
WantedBy=timers.target
```

The `runcmd` section in `cloud-init.yaml` conditionally enables the timer:
```bash
if [ "${browser_pool_autoscale_enabled}" = "true" ]; then
  systemctl enable browser-pool-autoscale.timer
  systemctl start browser-pool-autoscale.timer
fi
```

**1.5 — Randomize `NomadServiceRegistry.resolve()` instance selection**

`NomadServiceRegistry.resolve()` currently returns the first healthy instance from the Nomad service catalog. With multiple browser-pool instances, this creates an unbalanced pool. Change `resolve()` to return a random healthy instance from the catalog result set. This gives statistical load distribution with a one-line change (no API change, no new methods).

A full `resolveAll()` + round-robin approach is a cleaner follow-up if needed, but random selection is sufficient for the initial rollout. See RQ2.

**1.6 — Update README.md**

Add a "Browser-Pool Autoscaling" section to `infra/hetzner/README.md` documenting:
- How it works (single script, Nomad scale API, Browserless `/pressure` metrics).
- Configuration variables table.
- Manual override commands (`--dry-run`, `--help`).
- Systemd unit names and log locations.
- Relationship to agent-node autoscaling (composition via placement failures).
- Deploy-resets-count behavior: a `nomad job run` re-deploy resets count to 1; the autoscaler recovers within 60-120 seconds (see RQ3).

#### Files Modified

| File | Changes |
|---|---|
| `infra/nomad/browser-pool.nomad.hcl` | Add `scaling` block |
| `infra/hetzner/scripts/browser-pool-autoscale.sh` | New file — autoscale script |
| `infra/hetzner/variables.tf` | Add 7 new variables |
| `infra/hetzner/staging.tfvars` | Add browser-pool autoscale config (enabled) |
| `infra/hetzner/production.tfvars` | Add browser-pool autoscale config (disabled initially) |
| `infra/hetzner/cloud-init.yaml` | Add 2 systemd unit files + conditional timer enable |
| `apps/worker/src/agents/service-registry.ts` | Randomize instance selection in `NomadServiceRegistry.resolve()` |
| `infra/hetzner/README.md` | Add browser-pool autoscaling section |

#### Acceptance Criteria

- `browser-pool-autoscale.sh --dry-run` runs without error on a machine with `curl` and `jq`.
- `browser-pool-autoscale.sh --help` prints usage information.
- With `BROWSER_POOL_AUTOSCALE_ENABLED=false`, the script exits 2 immediately.
- With `--dry-run`, the script logs the utilization snapshot, the scale decision, and what it would do — without calling the Nomad scale API.
- The `scaling` block in `browser-pool.nomad.hcl` is accepted by `nomad job validate`.
- `pnpm lint` passes (no application code changes, but verify no drift).
- The systemd units in `cloud-init.yaml` are syntactically valid YAML (use `cloud-init devel schema --config-file` if available).

### Phase 2: Validation in staging

**Effort:** ~0.5 day
**Risk:** Low — staging only, feature-flagged.

#### Tasks

**2.1 — Deploy to staging**

Re-provision the staging control plane to pick up the new cloud-init (or manually deploy the script and systemd units for faster iteration).

**2.2 — Verify `/pressure` availability**

Confirm the open-source Browserless image exposes `/pressure`. If it returns 404, implement the fallback path (`/config` + `/sessions`) per D2 / RQ1.

**2.3 — Test scale-out**

Saturate the browser-pool by running concurrent `browse_interactive` calls. Verify:
- The autoscaler detects high utilization or queued requests.
- It scales from count=1 to count=2 via the Nomad scale API.
- The new instance registers in the Nomad service catalog.
- The `ServiceRegistry` in the worker resolves instances with random selection across healthy instances (per task 1.5).

**2.4 — Test scale-in**

Let the pool go idle. Verify:
- The low-utilization streak counter increments each check.
- After N consecutive checks (default 5), the autoscaler scales from count=2 to count=1.
- The removed instance deregisters from the Nomad service catalog.

**2.5 — Test composition with agent-node autoscaler**

Set `BROWSER_POOL_MAX_INSTANCES` high enough that Nomad can't place all instances. Verify:
- The browser-pool autoscaler increases count.
- Nomad marks the evaluation as blocked.
- The placement-failure watcher detects it and triggers agent-node scale-out.

**2.6 — Test alerting**

Simulate a failure (e.g., stop Nomad) and verify the alert pipeline fires after the configured failure threshold.

#### Acceptance Criteria

- Scale-out and scale-in both work end-to-end on staging.
- Alerts fire on repeated failures.
- The system composes with agent-node autoscaling (placement failures trigger node provisioning).

### Phase 3: Production rollout

**Effort:** ~0.5 day
**Risk:** Low — feature-flagged, starts disabled.

#### Tasks

**3.1 — Enable in production**

Set `browser_pool_autoscale_enabled = true` in `production.tfvars` with conservative thresholds:
- `browser_pool_max_instances = 3` (start small)
- `browser_pool_scale_out_utilization_pct = 70`
- `browser_pool_scale_in_utilization_pct = 20`
- `browser_pool_scale_in_stable_checks = 10` (more conservative than staging)
- `browser_pool_cooldown_seconds = 300`

**3.2 — Monitor**

Watch `journalctl -u browser-pool-autoscale` and `/var/log/browser-pool-autoscale.log` for the first few days. Verify scaling events are reasonable and not flapping.

**3.3 — Tune thresholds**

Adjust thresholds based on observed production traffic patterns.

---

## State Files

The script uses three state files (all in `/var/run/`, cleared on reboot):

| File | Purpose |
|---|---|
| `/var/run/browser-pool-autoscale-last-scale` | Unix timestamp of last scale event (cooldown) |
| `/var/run/browser-pool-autoscale-low-streak` | Integer count of consecutive low-utilization checks |
| `/var/run/browser-pool-autoscale-failure-count` | Consecutive failure count (alert tracking, via alert-common.sh) |

No Terraform state, no S3 backend, no flock file. The Nomad job scale API is idempotent — concurrent runs (unlikely given the 60s timer) would set the same count, which is harmless.

---

## Reused Infrastructure

| Component | What it provides |
|---|---|
| `scale-common.sh` | `log`, `die`, `nomad_api`, cooldown helpers (`check_cooldown_expired`, `touch_cooldown`), `is_dry_run` |
| `alert-common.sh` | `alert_failure`, `clear_failure_count`, `send_alert`, `send_recovery_alert` |
| `/etc/herobids/autoscale.env` | `NOMAD_TOKEN` for authenticated Nomad API calls |
| `cloud-init.yaml` template flow | Terraform variables → cloud-init → systemd Environment directives |
| `nomad-placement-failure-watcher` | Detects blocked browser-pool evaluations → triggers agent-node scale-out |

---

## Resolved Questions

### RQ1. Does the open-source Browserless image expose `/pressure`?

**Status:** Resolved — build the fallback path regardless.

The docs are ambiguous: `/pressure` is listed as a management endpoint for the open-source image, but the dedicated API page says "Private Deployment and Enterprise Docker plans." We will attempt `/pressure` first and cache availability per instance. If it returns 404 or non-JSON, the script falls back to `GET /config` (returns `maxConcurrent`) combined with `GET /sessions` (returns active session array — `length` gives `running`).

In fallback mode, `queued` and `recentlyRejected` are unavailable. Scale-out triggers only on utilization % (session count / max concurrent). This is less responsive than having queue depth but still functional. Phase 2.2 confirms which path is actually used in practice.

### RQ2. Worker-side instance resolution — single vs multiple addresses

**Status:** Resolved — randomize `NomadServiceRegistry.resolve()`.

Change `NomadServiceRegistry.resolve()` to return a random healthy instance from the Nomad service catalog result set instead of the first one. This gives statistical load distribution with a minimal code change — no new API methods, no interface changes to `ServiceRegistry` or `BrowserlessAdapter`.

A full `resolveAll()` + round-robin approach is a cleaner follow-up if empirical observation shows uneven distribution, but random selection is sufficient for the initial rollout.

Implementation is in Phase 1, task 1.5.

### RQ3. Nomad job re-deploy resets count

**Status:** Resolved — accept the brief capacity dip.

When `nomad job run browser-pool.nomad.hcl` is executed during a deploy, the `count = 1` in the HCL file overrides whatever the autoscaler set via the API. The autoscaler recovers within 60-120 seconds (one or two timer cycles). During that window, the pool operates at minimum capacity.

This is acceptable because:
- Deploys are infrequent.
- The autoscaler reacts on the very next 60s timer tick.
- The brief dip is bounded (at worst, a few browse_interactive calls queue or get 429'd, which the agent retries).

This behavior is documented in the README (task 1.6).

### RQ4. Cooldown file path — separate from agent-node autoscaler

**Status:** Resolved — confirmed correct.

The browser-pool autoscaler uses its own state files, independent from the agent-node autoscaler:
- Cooldown: `/var/run/browser-pool-autoscale-last-scale` (not `/var/run/nomad-autoscale-last-scale-out`)
- Failure count: `/var/run/browser-pool-autoscale-failure-count` (not `/var/run/nomad-autoscale-failure-count`)
- Last alert: `/var/run/browser-pool-autoscale-last-alert` (not `/var/run/nomad-autoscale-last-alert`)

The systemd unit overrides `NOMAD_AUTOSCALE_FAILURE_COUNT_FILE` and `NOMAD_AUTOSCALE_LAST_ALERT_FILE` to browser-pool-specific paths, so `alert-common.sh` operates on the correct files. A browser-pool scale event does not affect agent-node cooldowns, and vice versa.
