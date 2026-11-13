## Direct answers

**Hetzner limit — raise it to:** 150 servers, 150 Primary IPv4, and ~1,500 vCPU (launch-ready: production is ~85 `cx53` ≈ 1,360 vCPU plus staging/Traderton/headroom). Console text is saved in the plan (task 0.4). If you'd rather spend nothing extra until needed, a minimal bump (~+32 vCPU, enough for 2 `cx53`) unblocks just the switch test.

**Deferred items:** both the cx53 switch test and the EUR-50 load test are recorded as deferred. Your single todo source:
- `docs/features/2026/11/12/001-hetzner-scale-path/plan.md` — **task 0.4** (raise limit), **Phase 5** (load test), **§8 R1** (deferrals).
- `infra/hetzner/docs/runbooks/switch-node-type.md` — the cx53 switch procedure (has a "deferred, run after the limit raise" banner).

## Done this session (just now)

- **#10 live:** deployed the compose change; confirmed on staging — Redis `maxclients=10000` + `nofile=11000`, Postgres `max_connections=100`.
- **#13:** filled the Results table (cx23 live measurements + cx53 projections, deferred rows marked) and **set R1 = ready for review** with the two deferrals called out.
- Recorded the Hetzner-limit decision and the deferral across the plan + runbook.

## Final state

**Proven live on staging (all cx23):** Phase 1 (clean pool, `ownership_mismatch` fixed), scale-out + demand-aware scale-in, browser pool on its own node (smoke 10/10), sandbox shell access (NET_ADMIN-only, A-rows proven on a real agent), switch tooling + runbook + email alert. All tests/lint/build green.