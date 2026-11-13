## Direct answers

**Hetzner limit — raise it to:** 150 servers, 150 Primary IPv4, and ~1,500 vCPU (launch-ready: production is ~85 `cx53` ≈ 1,360 vCPU plus staging/Traderton/headroom). Console text is saved in the plan (task 0.4). If you'd rather spend nothing extra until needed, a minimal bump (~+32 vCPU, enough for 2 `cx53`) unblocks just the switch test.

**Deferred items (owner todo):** the cx53 switch test, the EUR-50 load test (Phase 5), and the Traderton capacity test (Phase 8) are all recorded as deferred. Your single todo source:
- `docs/features/2026/11/12/001-hetzner-scale-path/plan.md` — **task 0.4** (raise limit), **Phase 5** (load test), **Phase 8** (Traderton capacity test), **§8 R1** (deferrals).
- `infra/hetzner/docs/runbooks/switch-node-type.md` — the cx53 switch procedure (has a "deferred, run after the limit raise" banner).

**Traderton capacity test (Phase 8) — deferred, no resize.** Decision: skip the VM resize; when run, run against the current type (cx23) and extrapolate. Caveat recorded: CPU/memory extrapolate roughly linearly, but venue rate limits (per-IP 429), single-process event-loop lag, and shared-infra ceilings (Postgres/Redis) do **not** scale with VM size and may not surface on a small cx23 run. Approach when greenlit: ramp till something breaks, report the limiting factor, and label any 5,000 figure as an extrapolation, not a proven single-VM result.

## Production — done this session (Step 2 + converge)

**Step 2 complete and verified live on production (all cx23).** Rebuilt the agent node and added a dedicated browser node (fixed IP `10.0.0.240`); `hcloud_server.default` was never destroyed or replaced (in-place label only); nothing deleted.
- Browser pool live on its own node, re-deployed, worker rebuilt + recreated to re-resolve it; **smoke test 8/8 pass**.
- `capacityAwareStart.enabled: true` applied to `config/production.yaml` (the Step 1 config that had never actually been applied).
- **Fixed a long-broken prod autoscaler** (failure count was 11182): missing `HCLOUD_TOKEN`, demand mode off, wrong node pool (`ownership_mismatch`/`empty_inventory`), and a read-only-fs state-dir error. Autoscaler now runs clean under the timer; both timers re-enabled.

**The autoscaler config is now tooling-managed (converge), not hand-edits.** Important correction to an earlier note: the four fixes are **already produced by the committed provisioning code** — cloud-init emits `NOMAD_AUTOSCALE_NODE_POOL=${server_name}`, the `ReadWritePaths` + state dir, and the demand settings flow from tfvars; `setup-autoscale-env.sh` writes `HCLOUD_TOKEN`. There was nothing to codify. The prod control plane was simply provisioned from an older cloud-init and is frozen by `ignore_changes=[user_data]`, and `setup-control-plane.sh`/converge had never been run against it. I ran converge on prod, so the managed drop-ins (`10-autoscale-settings.conf`, `15-autoscale-node-pool.conf`, `20-autoscale-state-dir.conf`) and the rendered `autoscale-settings.env` now own these values; the temporary hand-added duplicates were removed. Converge also caught and fixed a real collision (the old `autoscale.env` duplicated `NOMAD_NODE_TEMPLATE_*` — removed, now sourced only from the rendered settings).

**Owner follow-up (not blockers):**
- Commit/push the `config/production.yaml` + `production.tfvars` edits to `main` (applied directly on the server to make prod live now; a clean redeploy would otherwise lose them).
- Deploy prod with **`deploy.sh --env production`**, not `push.sh` alone. `deploy.sh` step 3 runs `setup-control-plane.sh` (converge) automatically; the control plane is frozen (`ignore_changes=[user_data]`) so it only stays current if converge runs. The stale prod autoscaler is a symptom of past deploys that ran `push.sh` (app only) and skipped convergence.
- **Not done yet on prod:** task 7.6 — production sandbox shell access (the sandbox flag + pinned image are staging-only; prod agents still launch without sandbox caps). This is R2 work.

## Final state

**Proven live on staging (all cx23):** Phase 1 (clean pool, `ownership_mismatch` fixed), scale-out + demand-aware scale-in, browser pool on its own node (smoke 10/10), sandbox shell access (NET_ADMIN-only, A-rows proven on a real agent), switch tooling + runbook + email alert. All tests/lint/build green.

**Live on production (all cx23):** agent node + dedicated browser node (smoke 8/8), demand-aware autoscaler healthy, both timers active. Remaining plan work (cx53 switch test, Phase 5 load test, Phase 8 Traderton test, task 7.6 production sandbox) is deferred/gated.