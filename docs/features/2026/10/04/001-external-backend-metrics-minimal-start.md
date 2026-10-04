# External-Backend Metrics — Minimal Evolvable Start

**Status:** plan
**Created:** 2026-10-04
**Tech doc (source of truth):** [`docs/tech/architecture/observability.md`](../../../../tech/architecture/observability.md)
**Satisfies (partially, Phase 1):**
- `docs/features/pending/000-capability-foundations/005-trading-capability-extraction.md` (criterion 8; validation 8)
- `docs/features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md` (Latency Budget, Load-Test metrics)
- `infra/hetzner/docs/runbooks/phase1-operational-readiness.md` (§D1, D3 — the "N/A, no instrumentation" items)
- `traderton/docs/features/initial/007-operational-readiness.md` (Phase 2 only; see §Non-goals)

## Goal

Add the smallest metrics layer that produces the readiness numbers for
external-backend tool invocation, with a port seam that grows into a real
aggregation backend later. Deliver Phase 1 (herobids only, no cross-repo
contract change): **end-to-end latency, throughput, error-rate-by-code**, plus
operator-configurable latency budgets. Write the observability doc and link every
site that calls for metrics to it.

Full rationale and the readiness-item mapping live in the tech doc. This plan is
the build steps.

## Non-goals (this phase)

- No boundary-overhead number yet (needs the Phase 2 contract field + Traderton
  dispatcher stamp). The sample shape reserves `backendDurationMs` so Phase 2 is
  additive.
- No `/metrics` endpoint, no Prometheus/OTel/statsd adapter, no in-process
  percentile aggregation. Percentiles are computed offline from the pino lines.
- No idempotency-violation metric (belongs to write-dedup verification).
- No new runtime dependency.
- No change to `traderton/` in this phase.

## Design summary (see tech doc for detail)

- Single chokepoint: `ExternalBackendClient.invoke` in
  `packages/domain/src/external-backend/client.ts`.
- `MetricsSink` port + flat `ExternalBackendInvocationSample` in
  `@herobids/domain/external-backend`; **no-op default** so unconfigured clients
  and existing tests are unaffected.
- pino-backed sink adapter in the app layer; injected at the ~5 composition
  sites.
- Budgets in config at `externalBackendObservability.latencyTargets.*`
  (sibling block, because `externalBackends` is a registry array) — read only by
  harnesses, never on the live path.

## Work items

### 1. Sink port + sample type (domain) — DONE

**File (new):** `packages/domain/src/external-backend/metrics.ts`

- Export `ExternalBackendInvocationSample` exactly as in the tech doc (flat,
  serialisable; `code`/`retryable` optional; `backendDurationMs` optional).
- Export `MetricsSink` with `recordInvocation(sample): void`.
- Export `NOOP_METRICS_SINK: MetricsSink` (empty body).
- Pure types + a const. No node imports (keeps the module barrel-safe).
- Top-of-file comment MUST link to `docs/tech/architecture/observability.md`.

**File:** `packages/domain/src/external-backend/index.ts`
- Add `export * from './metrics.js';`.

**Tests (new):** `packages/domain/src/external-backend/metrics.test.ts`
- `NOOP_METRICS_SINK.recordInvocation` is callable and returns void (behavioural:
  "no-op sink accepts a sample without throwing").

### 2. Instrument the client (domain) — DONE

**File:** `packages/domain/src/external-backend/client.ts`

- Add optional `metrics?: MetricsSink` to `ExternalBackendClientConfig`.
- Store `this.metrics = config.metrics ?? NOOP_METRICS_SINK` and `this.backendId`
  (derive from config — add an optional `backendId?: string` to the config, set
  by `buildExternalBackendClientConfig`; default `'unknown'` if absent so no call
  site breaks).
- In `invoke`: capture `start = Date.now()` before the transport call; after
  mapping the result, build a sample from `envelope` (toolName, requestId,
  correlationId) + the mapped `ExternalBackendClientResult` (outcome kind, and
  for `failure` the `code`/`retryable`; for `transport_error` set
  `retryable: true`) + `durationMs = Date.now() - start`, and call
  `this.metrics.recordInvocation(sample)` inside a `try/catch` that swallows (a
  metrics error must never alter the returned result).
- Do NOT instrument `invokeAndAwait`/`poll` separately in Phase 1 — they call
  `invoke`, so each underlying attempt is already one sample. (A logical-write
  timer is a documented later option, not now — keeps the slice minimal.)
- Update the top-of-file comment to reference `docs/tech/architecture/observability.md` for
  the metrics seam.

**File:** `packages/domain/src/external-backend/client-config.ts`
- Set `backendId: definition.backendId` in the returned config.
- `metrics` is injected at the composition site, not here (this helper has no
  sink). Document that in a one-line comment linking the tech doc.

**Tests:** `packages/domain/src/external-backend/client.test.ts` (extend)
- "records one success sample with the invoked tool name and a non-negative
  durationMs"
- "records a failure sample carrying the failure code and retryable flag"
- "records a transport_error sample as retryable"
- "a throwing metrics sink does not change the returned result" (inject a sink
  whose `recordInvocation` throws; assert the result is unchanged).

### 3. pino sink adapter (apps) — DONE (option b: logger sink in domain)

**File (new):** `apps/worker/src/external-backend/pino-metrics-sink.ts`

- `createPinoMetricsSink(logger): MetricsSink` — `recordInvocation` emits
  `logger.info({ evt: 'external_backend.invocation', ...sample })`. Omit
  `undefined` fields. Never throw.
- Top-of-file comment links `docs/tech/architecture/observability.md`.
- Reuse `createLogger('external-backend-metrics')` from `apps/worker/src/logger.ts`
  at the composition sites (do not create a logger inside the adapter — inject it).

**Decision — shared vs duplicated adapter:** the worker and api both need it, and
apps must not import each other. Options:
  (a) place the adapter in `apps/worker` and a thin copy in `apps/api`, or
  (b) place it in `@herobids/domain/external-backend` since it only depends on a
      structural `{ info(obj, msg) }` logger (pino-compatible), not on pino itself.
**Recommended:** (b) — a `createLoggerMetricsSink(logger)` in domain that takes a
minimal `{ info(fields, msg): void }` logger interface (the same shape
`AgentExternalBackendPortsLogger` already uses in `agent-ports.ts`). It pulls no
I/O into domain (the logger is injected), removes duplication, and both apps pass
their own pino `createLogger(...)`. If the reviewer prefers apps-only placement,
fall back to (a). Resolve during implementation; default to (b).
  - Under (b): new file `packages/domain/src/external-backend/logger-metrics-sink.ts`,
    exported from the subpath barrel; drop the `apps/worker` adapter file above.

### 4. Wire the sink at the composition sites (apps) — DONE

Pass `metrics: createLoggerMetricsSink(createLogger('external-backend-metrics'))`
into each `createExternalBackendClient(buildExternalBackendClientConfig(...))`
call. `buildExternalBackendClientConfig` returns the base config; spread the
`metrics` sink onto it at the call site (or extend the helper to accept an
optional sink — pick one and apply uniformly; recommended: extend the helper with
an optional second arg `{ metrics }` so every site is consistent and the backlink
comment lives in one place).

Sites (verified):
- `apps/worker/src/index.ts` — four construction points (write boundary,
  evidence read client x2, and the shared read client near the bottom).
- `apps/worker/src/external-backend/agent-ports.ts` — `buildAgentExternalBackendPorts`.
- `apps/api/src/index.ts` — `tradingBackendClient`.

Each site gets a one-line comment: `// metrics: see docs/tech/architecture/observability.md`.

### 5. Config — latency budgets — DONE

**File:** `packages/domain/src/config/schema.ts`
- Add a top-level block beside `externalBackends`:
  ```ts
  /** External-backend latency budgets (measurement targets; see docs/tech/architecture/observability.md). */
  externalBackendObservability: z.object({
    latencyTargets: z.object({
      p50Ms: z.number().int().positive().default(200),
      p95Ms: z.number().int().positive().default(500),
      p99Ms: z.number().int().positive().default(2000),
    }).default({}),
  }).default({}),
  ```
- These are consumed by harness/test code only; the client does not read them.

**File:** `config/default.yaml`
- Add the `externalBackendObservability` block with the three defaults and an
  inline comment per key linking the readiness default + the tech doc.

**File:** `packages/domain/src/config/schema.test.ts` (or the nearest config test)
- "defaults the external-backend latency targets to 200/500/2000 when the block
  is absent"
- "accepts operator overrides for the latency targets".

**Env twins:** none. These are operator YAML, not secrets — no `.env.example`
change (consistent with AGENTS.md: `.example` documents env inputs only).

### 6. Documentation backlinks (the "link every site" requirement) — DONE

Add a short pointer to `docs/tech/architecture/observability.md` at every place that *calls
for* metrics, so a reader at any entry point finds the one source of truth:

Readiness docs (add a one-line "Instrumentation" note linking the tech doc):
- `docs/features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md`
  — under "Load-Test Expectations → Metrics To Record" and "Latency Budget".
- `docs/features/pending/000-capability-foundations/005-trading-capability-extraction.md`
  — under "Implementation Notes → Operational readiness".
- `traderton/docs/features/initial/007-operational-readiness.md`
  — under "Latency Budget" (note: Traderton-side duration is Phase 2).

Runbook (update the stale "no instrumentation" framing to point forward):
- `infra/hetzner/docs/runbooks/phase1-operational-readiness.md` — in §D add a line:
  Phase 1 instrumentation now defined in `docs/tech/architecture/observability.md`; §D1/D3
  become obtainable once this plan ships. Do NOT rewrite the historical evidence;
  append a dated forward-pointer only.

Code backlinks (top-of-file comment → tech doc):
- `packages/domain/src/external-backend/client.ts`
- `packages/domain/src/external-backend/metrics.ts`
- `packages/domain/src/external-backend/logger-metrics-sink.ts` (if (b))
- each composition site touched in step 4 (one-line comment).

> Keep every backlink a relative markdown path so it survives repo moves. Verify
> each link resolves before marking the plan done.

## File-change summary

New:
- `packages/domain/src/external-backend/metrics.ts` (+ `.test.ts`)
- `packages/domain/src/external-backend/logger-metrics-sink.ts` (option (b))
- `docs/tech/architecture/observability.md` (already created)
- this plan

Edited:
- `packages/domain/src/external-backend/index.ts` (exports)
- `packages/domain/src/external-backend/client.ts` (instrument + config field)
- `packages/domain/src/external-backend/client-config.ts` (backendId; optional sink arg)
- `packages/domain/src/config/schema.ts` (`externalBackendObservability`)
- `config/default.yaml` (budgets block)
- `apps/worker/src/index.ts`, `apps/worker/src/external-backend/agent-ports.ts`,
  `apps/api/src/index.ts` (inject sink)
- the four docs in step 6 (backlinks)

## Validation

1. `pnpm lint` (strict typecheck — no `any`, no `@ts-ignore`).
2. `pnpm test` focused on `packages/domain/src/external-backend/*` and the config
   schema test.
3. `pnpm build`.
4. Manual: run the worker locally against a stubbed/staging boundary, make one
   `get_price` call, confirm exactly one `evt: 'external_backend.invocation'`
   line with `toolName`, `outcome`, `durationMs`, `requestId`, `correlationId`,
   and no secret/payload fields.
5. Confirm every backlink added in step 6 resolves.

## Acceptance criteria

1. Every external-backend `invoke` emits exactly one sample through the sink.
2. Success, failure (with `code`+`retryable`), and `transport_error` are all
   recorded; a throwing sink never alters a trading result.
3. Latency targets are operator-configurable with the documented defaults and are
   not consulted on the live request path.
4. No new dependency; `pnpm lint`/`test`/`build` pass.
5. `docs/tech/architecture/observability.md` exists and every metrics-calling site (readiness
   docs, runbook, instrumented code) links to it.
6. No `traderton/` change and no boundary-contract change in this phase
   (`backendDurationMs` stays an unused reserved slot).

## Phase 2 (follow-up, not this plan)

Additive `backendDurationMs` on `ExternalBackendToolResultV1`, stamped by the
Traderton dispatcher and read into the sample, unlocking boundary-overhead =
`durationMs − backendDurationMs`. Sink and aggregation unchanged. Tracked
separately once this ships.

## Outstanding Issues

Non-blocking (LOW) review findings, grouped by work item. None are CRITICAL/HIGH.

### Item 1 — Sink port + sample type
- [LOW] The `metrics.test.ts` test only exercises a `'success'` sample literal; a
  `'failure'` literal (with `code`+`retryable`) would additionally exercise the
  optional fields' assignability. Covered indirectly by the Item 2 client tests,
  so optional.

### Item 2 — Instrument the client
- [RESOLVED] [was MEDIUM] `in_progress` sample shape was untested — added test
  "records an in_progress sample with no code or retryable" (full outcome coverage).
- [LOW] `durationMs` is captured after `buildEnvelope` (excludes envelope build,
  includes transport + map). Consistent with observability.md ("encode→send→
  decode→map"); envelope build is non-I/O and negligible. No action.
- [LOW] Sample is built with mutually-exclusive conditional spreads
  (`failure`→code+retryable, `transport_error`→retryable). Correct today; prefer
  an explicit switch if a future outcome also needs `retryable`.

### Item 3 — Logger-backed sink (option b, domain)
- Chose option (b): `createLoggerMetricsSink(logger)` in
  `packages/domain/src/external-backend/logger-metrics-sink.ts`, taking a
  structural `MetricsLogger` (`info(fields, msg)`); no pino import, domain stays
  I/O-free. The `apps/worker` adapter file in the original plan draft is NOT
  created.
- [LOW] The barrel re-exports `MetricsLogger` package-wide (intended; apps may
  want the type). No action.
- [LOW] No sink-level test for `in_progress`/`transport_error` round-trip — the
  adapter is outcome-agnostic and the client layer (Item 2) has full outcome
  coverage. No action.

### Item 4 — Wire the sink at the composition sites
- Chose the recommended uniform approach: `buildExternalBackendClientConfig`
  gained an optional 3rd `options?: { metrics? }` arg; the key is omitted when
  absent (no-op default path preserved). Wired 6 sites: api `tradingBackendClient`;
  worker `sideEffectBoundary`, `systemReadBoundary`, `alertDispatcherFeed`,
  `evaluationReadClient` (one shared per-process sink); agent-ports (reuses its
  injected per-container logger).
- [RESOLVED] [was HIGH] Three config parity tests
  (`client-config.test.ts`, worker `config.test.ts`, api `config.test.ts`) were
  RED — they `.toEqual(...)` the exact `buildExternalBackendClientConfig` shape
  and had not been updated when `backendId` landed in Item 2 (commit 3d34004e;
  `mcpPath`/`toolProtocolOverrides` even earlier). Fixed by adding the missing
  expected fields. Root cause: Item 2's Implementer ran lint + client tests but
  not these parity suites, and the Item 2 review did not run the full suite. No
  production behaviour was wrong.
- [LOW] The two app parity tests use full `.toEqual(...)` shape and are brittle;
  consider `.toMatchObject(...)` in future.
- [LOW] Minor comment-accuracy nit in `logger-metrics-sink.ts` (noted, no action).

### Item 5 — Config latency budgets
- Added `externalBackendObservability.latencyTargets.{p50Ms,p95Ms,p99Ms}`
  (defaults 200/500/2000) as a top-level sibling of `externalBackends` in
  `schema.ts` + `config/default.yaml`. Measurement targets only; nothing on the
  runtime/request path reads them (verified by grep). No `.env` twin (operator
  YAML, not a secret).
- [LOW] Targets have no upper bound and no p50≤p95≤p99 ordering invariant.
  Harmless (never enforced at runtime); defensive polish only. No action.

### Item 6 — Documentation backlinks
- Added blockquote backlinks to `docs/tech/architecture/observability.md` in readiness docs
  014 (Metrics To Record + Default Targets) and 005 (Operational readiness), and
  an append-only dated forward-pointer in the phase1 runbook §D (historical
  2026-10-01 evidence left intact). The traderton 007 doc references the herobids
  tech doc by repo-relative description (cross-repo — no dangling markdown link).
  Code top-of-file backlinks were added in Items 1–4. All herobids relative links
  verified to resolve.
- [LOW] Backlink note style is now blockquote across all herobids sites (resolved
  the 005 `0.`-ordinal nit). traderton uses the same blockquote device.
