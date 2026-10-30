# Capacity economics and latency - implementation plan

**Date:** 2026-10-30  
**Status:** Future measurement/decision plan; no measured readiness, realized
revenue, production defaults or optimization implementation claimed.  
**Related:** [roadmap](000-roadmap.md), [objectives](010-objectives.md),
[options](011-scale-out-options.md), [001 safe expansion](001-safe-capacity-expansion-plan.md),
[002 continuation](002-durable-agent-continuation-plan.md),
[003 maintenance](003-controlled-maintenance-and-recovery-plan.md).

## 1. Goal and non-goals

Measure what it costs to provide safe useful agent capacity, what users are
actually charged, and where admission/startup/recovery latency comes from. Use
that evidence to propose bounded capacity ceilings and small experiments without
silently changing billing, fairness or operational reserve.

Non-invasive instrumentation and offline analysis may start alongside milestone
1. Invasive cost/performance changes require evidence, proven continuation and
separate owner approval; destructive optimization additionally follows 003.
Keep Nomad and Terraform initially.

**Non-goals:** deriving a node cap from accrued revenue; eliminating intentionally
idle recovery headroom; replacing resource reservations with guessed utilization;
new dynamic pricing or paid-tier preference; an observability platform;
automatically switching provisioner, buying warm pools or changing Terraform
state ownership. No live reads, deployment, timer changes or benchmark against
production is authorized by this document.

Staging autoscale remains owner-stopped under the incident freeze: unknown
agent startup-script drift must be identified, replacement guard implemented/
tested and milestone-1 gates passed before explicit owner re-enablement.
Production timer/plan exposure is unknown. Existing `--dry-run` can initialize
Terraform/workspaces before exiting; it is not a guaranteed read-only measurement
tool. Separate analysis of existing artifacts/read-only GETs from any new
plan/backend preparation/locking, which needs owner approval where shared state
is affected.

Milestone 1's section 0 exposure/drift gate and disposable acceptance precede
shared mutation. Its mutation guard is unconditional across legacy,
feature-gate-off and rollback paths; an old unguarded binary requires leaving
timers stopped. Cost or latency experiments cannot bypass these requirements.

Any continuation-dependent experiment inherits 002's effect support matrix:
arbitrary `execute_shell`, browser and web/direct HTTP effects are unsupported
for the no-duplicate guarantee unless enforceable ownership plus idempotency/
reconciliation is demonstrated for the specific path. Database fencing alone
cannot establish universal external-effect safety; performance gains cannot
justify weakening this boundary.

## 2. Local evidence and mandatory discovery

| Existing source | What it establishes, and what it does not |
|---|---|
| [config/default.yaml](../../../../../../config/default.yaml), `usageBilling.defaultRateCardItems` | `agent.runtime_ms`: 100 microusd per 60,000 ms = $0.0001/minute = **$0.006/hour**. This is a seed/default rate, not realized revenue or the effective rate for every account. |
| [usage-billing-service.ts](../../../../../../apps/worker/src/usage-billing-service.ts), `doRecordRuntimeWindow`, `flushRuntimeWindow`, `recordBrowserSession` | Runtime usage is recorded/rated using active database rate-card items when available; runtime event keys include session and interval. Browser usage is separate. Fire-and-forget recording needs crash/accounting tests, not assumptions of complete realized collections. |
| [usage-billing-repository.ts](../../../../../../packages/db/src/usage-billing-repository.ts), [rate-card schema](../../../../../../packages/db/src/schema/billing-rate-card-items.ts), [usage events](../../../../../../packages/db/src/schema/billing-usage-events.ts) | Existing persisted pricing and usage are discovery anchors for billed usage and idempotency; charges are not the same as collected cash or net margin. |
| [nomad-runtime-adapter.ts](../../../../../../apps/worker/src/agents/nomad-runtime-adapter.ts), `buildNomadJobSpec` | Resource requests/job constraints and startup events are measurement anchors; reservation is neither actual memory usage nor evidence of safe overcommit. |
| [runtime port](../../../../../../packages/domain/src/ports/runtime.ts), [launcher](../../../../../../apps/worker/src/agents/agent-runtime-launcher.ts), [session manager](../../../../../../apps/worker/src/agents/agent-session-manager.ts) | Existing profiles, lifecycle and heartbeat/placement boundaries need correlation to useful work, not just launch success. |
| [check-nomad-capacity.sh](../../../../../../infra/hetzner/scripts/check-nomad-capacity.sh), [scale-out.sh](../../../../../../infra/hetzner/scripts/scale-out.sh), [main.tf](../../../../../../infra/hetzner/main.tf) | Managed capacity, node shapes and controller decisions are local source anchors, not verified prices, fleet count, deployed behavior or production policy. |
| [worker index](../../../../../../apps/worker/src/index.ts), [Dockerfile.agent](../../../../../../docker/Dockerfile.agent) | Shared browser-pool discovery and ephemeral agent workspace affect overhead/startup. Browser memory/cost is not necessarily inside agent RSS. |

Before editing, read [AGENTS.md](../../../../../../AGENTS.md),
[lessons](../../../../../../docs/lessons/lessons-from-previous-project.md),
[best practices](../../../../../../docs/best-practices/README.md),
[configuration](../../../../../../docs/best-practices/configuration.md),
[runtime rules](../../../../../../docs/best-practices/agent-runtime.md),
[billing semantics](../../../../../../docs/tech/agents/billing-enforcement-semantics.md),
[infra index](../../../../../../infra/hetzner/docs/README.md) and
[infra lessons](../../../../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md).
Review current history, bug reports, 001 contract and schema/migration state.

Mandatory discovery before recommending policy:

- Trace effective rate-card selection, usage event durability, ledger settlement,
  free credits/subsidies, allowances, refunds, tax/FX treatment and payment fees.
  Distinguish usage, gross rated charges, recognized revenue and collected cash.
  Use approved sanitized exports/offline fixtures initially; production DB/payment
  access is not implicitly approved.
- Enumerate incremental and fixed costs: server rounding/minimum billing,
  guaranteed reserve, failed/booting nodes, control-plane share, shared browser
  pool, persistent/temporary storage, snapshots/backups, network, external-model/
  connector pass-through, payment fees and explicit free-user subsidy.
  Obtain approved dated provider prices/currency assumptions; do not assert
  current market prices from code.
- Inventory hard spend limit, cloud/node/operational maximum, guaranteed recovery
  reserve, admission/concurrency limits and fairness policy separately. Unknown
  budgets block activation, not measurement. Unready managed nodes still count
  toward relevant spend/cap exposure.
- Measure agent CPU, peak RSS, memory limit/reservation, OOM/eviction/restarts,
  disk/I/O/network and browser shared overhead by representative workload.
  Include idle, reasoning-heavy, tool-heavy, browser-heavy, large-context, cold
  start and recovery cases. Do not infer density solely from reserved memory or
  average usage.
- Trace correlation IDs/timestamps for request acceptance, capacity wait, demand
  observation, provisioning, node readiness, placement, image pull, first
  heartbeat, first useful work, continuation restore and reconciliation.
  Separate capacity queue from billing rejection and application failure.

## 3. Measurement and economic contracts

Prefer existing structured logs, usage records and test harnesses. Add only
missing bounded-cardinality fields/counters/histograms; do not introduce a new
dependency or monitoring stack without demonstrated need. IDs belong in
restricted audit/log records, not unbounded metric labels. Never log secrets,
raw Terraform plans, private prompts or provider hidden reasoning.

Suggested event fields: logical agent/session, attempt/epoch when 002 exists,
stage, reason code, monotonic duration, correlation/operation ID, workload class,
requested/reserved/observed resources and effective config revision. Proposed
fields are not existing APIs. Cross-host wall timestamps need clock-skew checks;
prefer local monotonic stage durations and explicitly bounded correlation error.
Record missing data and confidence/sample count rather than substituting zero.

No new listener/port/storage service is required initially. Instrument worker/
runtime/Nomad adapters and analyze approved exports through existing tooling.
Existing API/UI metrics remain authenticated and tenant-scoped. If persistent
observations require schema changes, reuse current usage/audit structures where
semantically correct; otherwise add a small retention-bounded table/repository
and generated migration with journal. Do not overload billable usage events with
nonbillable telemetry or store business-critical data only in temporary logs.

### Cost/ceiling formulas to implement and test

Use a single documented currency and time horizon `H` with auditable inputs.
Account for per-resource provider billing granularity and tax/FX consistently.

- `R_gross(H) = sum(actual rated eligible usage * effective rate-card price)`
  after the existing rate-card/discount rules; reconcile to ledger. This is not
  automatically collected cash.
- `R_net(H) = attributable recognized revenue - refunds - payment/collection
  fees - variable model/connector costs not already excluded from revenue`.
  State treatment explicitly so pass-through costs/fees are not counted twice.
- `C_capacity(H) = sum(node billed cost) + browser pool + storage/backup/network
  + incremental control-plane/operational cost`. Include booting/failed/reserve
  exposure; state any allocation of fixed costs separately.
- `Contribution(H) = R_net(H) - C_capacity(H)`. Show cohort/subsidy allocation
  and incremental versus fully allocated views. An intentional approved free/
  recovery reserve budget can fund negative incremental contribution.
- For a representative additional node, let `c` be its all-in incremental cost
  per hour and `m` the net per-active-agent-hour contribution **before that node
  cost**, with non-node variable costs already deducted. `A_break_even = c / m`
  only if `m > 0`. If usable slots are `K`, required occupancy is `c / (K * m)`;
  occupancy above 1 is infeasible at those inputs. If `m <= 0`, there is no
  positive-occupancy break-even under those assumptions.
- Model candidate total node count `n`, guaranteed reserve `r` and horizon
  budget `B`: admissible capacity must satisfy operational max and total
  projected billed exposure `C_projected(n,r,H) <= B`, while preserving the approved
  reserve. Evaluate provider rounding and outstanding committed resources.
  A simplified affine case is `n_max = min(N_operational,
  floor((B - C_non_node(H)) / c_node(H)))`, valid only when costs are homogeneous
  and reserve nodes are included in `n`, not subtracted away. Negative residual
  budget means "no admissible expansion", not a negative node count. Heterogeneous
  pools need a bounded resource-cost calculation, not this shortcut.

Budget `B`, reserve `r`, operational max, free subsidy and acceptable margin/risk
must be owner-approved inputs, never magic production defaults or functions of
accrued revenue. A hard spend cap is independent of concurrency/fair admission:
at cap, return a truthful capacity reason and preserve waiting/cancel semantics.
Do not silently favor paying tiers or change pricing.

Sensitivity report: vary realized effective price/collections, free share,
active occupancy, node price/billing rounding, browser concurrency, storage growth,
provider failures, reserve size and observed resource density. Give ranges and
break-even failure cases, not one optimistic "agents per server" estimate.

## 4. Ordered implementation tasks and dependencies

1. **Approve measurement contract and inputs.** Produce workload matrix,
   timestamps, resource/cost ownership map, sample adequacy criteria, sanitized
   data access method, horizon/currency and approved budget/reserve inputs where
   known. Measurement may proceed with explicitly hypothetical sensitivity inputs
   but cannot activate policy from them. **Depends on:** code rediscovery and
   milestone-1 status/reason-code alignment.
2. **Add minimal observation points and offline fixtures.** Modify existing
   launcher/session-manager/Nomad adapter/capacity-controller decision logs and
   [usage billing](../../../../../../apps/worker/src/usage-billing-service.ts)
   only where needed for correlated accounting, without changing charges.
   Wire through [worker index](../../../../../../apps/worker/src/index.ts) and
   resolved [config schema](../../../../../../packages/domain/src/config/schema.ts)/
   [defaults](../../../../../../config/default.yaml). Flags/retention/sampling
   must be typed, bounded and disabled or conservative by default; update env
   example twins if keys change. Add repositories/migrations only if justified.
   **Depends on:** task 1. No invasive tuning here.
3. **Establish disposable baseline and accounting reconciliation.** Collect
   cold/warm startup, backlog, scale-from-zero, at-cap waiting, failed-node and
   representative workloads. Reconcile runtime/browser usage against canonical
   intervals and effective rate cards using
   [billing repository](../../../../../../packages/db/src/usage-billing-repository.ts).
   Find missing/double charge windows before interpreting revenue. Capacity
   waiting has no runtime billing; overlap must not double bill; downtime policy
   is explicit and audited, not silently chosen by instrumentation.
   **Depends on:** task 2; recovery measurements additionally depend on 002.
4. **Implement reproducible offline economics/latency report.** Add a small
   analysis module/script in the existing test/tooling layout selected during
   discovery, with pure formulas, versioned sanitized input schema and fixtures.
   Report p50/p95/p99 only with sample counts/confidence appropriate to the data,
   maximums, stage breakdown, queue reasons, OOMs and costs. Include reserve/free
   budget and adverse sensitivities. New file names are selected after layout
   discovery, not presumed existing. **Depends on:** tasks 1 and 3.
5. **Present evidence-based capacity recommendations, not automatic policy.**
   Propose hard spend/operational ceilings and resource templates separately
   from fair admission/concurrency. Explain at-cap reasons and retained recovery
   reserve. Any actual config changes use 001's protected plan review and
   disposable acceptance; owner approval is required for values/activation.
   If status/cost estimates are exposed, update
   [agents API](../../../../../../apps/api/src/routes/agents.ts),
   [billing API](../../../../../../apps/api/src/routes/billing.ts),
   [AgentDetailPage](../../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
   and [BillingPage](../../../../../../apps/web/src/features/billing/BillingPage.tsx)
   with tenant-scoped, explicitly estimated versus actual fields. No pricing or
   admission priority change without a separate user-policy decision.
   **Depends on:** task 4 and explicit owner decisions.
6. **Run one small approved optimization experiment at a time.** Rank measured
   bottlenecks first: image size/cache, request latency, resource sizing or
   shared-browser pressure. Predeclare benefit, resource/failure limits, billing
   invariants and rollback. Invasive changes require 002 continuation proof;
   destructive/node-moving ones require 003 approval. Re-test CPU, peak RSS/OOM,
   scheduler reservations and burst/recovery workload before any density change.
   **Depends on:** tasks 3-5 and relevant continuity/maintenance gates.
7. **Decide deferred alternatives only if evidence warrants.** Evaluate direct
   Hetzner API provisioning, autoscaler/plugin, snapshots/warm pools or Terraform
   state separation using measured latency savings, total cost, operational/
   identity risk, support and rollback costs. Check authoritative current plugin
   compatibility/support claims: a Hetzner community plugin is not automatically
   HashiCorp-supported. Keep alternatives unimplemented unless separately
   approved with a concrete plan. **Depends on:** task 6 evidence, not enthusiasm
   for new architecture.

## 5. Tests, failure injection and acceptance

Unit-test rate conversion (`100 microusd / 60,000 ms -> $0.006/hour`), effective
rate selection fixtures, cost rounding, free/discount/refund/fees treatment,
nonpositive margin, infeasible occupancy, negative budget residual and
heterogeneous-resource refusal. Test currency/horizon/unit validation, missing
data, interval overlap, skew bounds and redaction. Avoid float-induced money
errors by following current integer money conventions.

Integration-test repository usage/ledger reconciliation with multiple effective
rate cards, duplicates and delayed events; waiting/recovery/overlapping attempts
must follow the approved policy with zero double billing. Reuse
[usage-billing-service tests](../../../../../../apps/worker/src/usage-billing-service.test.ts),
[repository integration tests](../../../../../../packages/db/src/usage-billing-repository.integration.test.ts)
and [capacity shell tests](../../../../../../infra/hetzner/scripts/tests/check-nomad-capacity.test.sh)
where appropriate, adding targeted tests beside new modules.

Disposable failure matrix:

| Injection | Acceptance |
|---|---|
| Cold image, slow node boot, placement backlog | Correct stage attribution, missing-data flags and truthful queue reason; no waiting runtime charge or false useful-work readiness. |
| Kill runtime/worker before billing flush; replay usage | Accounted approved intervals, no duplicate overlap charges; gaps surfaced/reconciled under explicit policy. |
| CPU burst, peak-memory spike/OOM, browser saturation | Observed peaks/shared overhead recorded; proposed density rejected if it breaches approved safety envelope. |
| Failed/unready managed nodes at spend/node cap | Cost/cap exposure retained; explicit reason and no hidden replacement/deletion or desired-count reset. |
| Price/cost inputs missing or stale; telemetry/DB unavailable | No invented zero cost or unlimited cap; existing safe policy retained, uncertainty exposed, no automatic policy activation. |
| Revenue falls/free cohort grows/reserve is idle | Budget/subsidy/reserve modeled explicitly; no unapproved eviction or reserve deletion based on accrued revenue. |
| Proposed tuning reduces p50 but worsens tail/recovery/OOM | Experiment fails predeclared acceptance and rolls back; report adverse result rather than hiding it. |

Approve exact numerical experiment thresholds after baseline: target stage
latency improvement, minimum sample/workload coverage, maximum peak resource/
failure exposure and contribution/cost ceiling. Before that approval no
production-safe density or savings claim is valid. Visually verify estimated
versus billed values, units, waiting/at-cap reasons and restricted financial
visibility on any changed UI.

## 6. Rollout, rollback and final evidence

Rollout gates: read-only/offline measurement contract -> unit/integration
accounting checks -> representative disposable baseline -> owner-approved
budget/reserve and exact experiment thresholds -> explicit staging measurement/
experiment approval -> reviewed result -> separate production approval. Telemetry
approval is not approval for policy, billing changes, timer enablement or
infrastructure mutation.

Rollback measurement by disabling added instrumentation and retaining sanitized
auditable outputs without deleting billing records. Roll back resource/tuning
changes to recorded configuration/image only if active-attempt/continuation
compatibility is preserved; do not remove capacity serving agents as cleanup.
Use 003 for any approved node move/destruction. Budget exhaustion or measurement
failure keeps known-safe limits/reserve and reports why expansion is blocked;
it never silently enables unsafe overcommit.

Final evidence: revision/config and any migration journal, collection method/
permissions, timestamp/resource schema, dated price assumptions, active-rate-card
reconciliation, formula tests, workload/sample coverage, latency/resource/failure
distributions, contribution/break-even sensitivity, approved spend/reserve/free
budgets, proposed versus activated policy, UI/billing checks and rollback result.
List unknowns explicitly. Exact capacity defaults, downtime accounting,
pricing/fairness changes, new dependencies/ports and deferred architecture choices
remain gated owner decisions; this document supplies no automatic production
values.
