# Observability — External-Backend Invocation Metrics

**Status:** living
**Created:** 2026-10-04
**Scope:** metrics/telemetry for external-backend (boundary) tool invocation.
**Owning seam:** `ExternalBackendClient.invoke` in
`packages/domain/src/external-backend/client.ts`.

This is the single source of truth for how the platform measures external-backend
tool invocations. Every readiness document that asks for a latency percentile,
throughput, error-rate, or boundary-overhead figure is satisfied by the layer
described here. If you arrived from a readiness doc or a code comment that links
here, the section you want is [What each readiness item maps to](#what-each-readiness-item-maps-to).

## Why this exists

The readiness specifications ask for measured, operator-configurable latency and
error metrics at the external-backend boundary. They deliberately do **not**
mandate an observability stack, and they warn against standing up monitoring
infrastructure prematurely. Before this layer, the codebase had no metrics system
at all — only `pino` structured logging and `Date.now()` used for deadline math.

This layer is the smallest thing that produces the required numbers while leaving
a clean seam to grow into a real aggregation backend later. It adds **no new
runtime dependency**.

## Design principles

1. **One chokepoint.** Every boundary call — read, write, reconciled write, poll
   — funnels through `ExternalBackendClient.invoke`. Instrumentation lives there
   and nowhere else, so no call site can be measured inconsistently or forgotten.
2. **Port, not a vendor.** The client depends on a `MetricsSink` interface, never
   on a metrics library. The default sink writes one structured log line per
   call. A Prometheus / OpenTelemetry / statsd adapter can replace it later with
   zero changes to the client or any caller.
3. **No runtime gating.** Latency targets are *measurement budgets* consumed by
   test/load harnesses, not request guards. The client never rejects or delays a
   call based on a target. Deadlines (a separate concern) remain the only
   time-based control on a live call.
4. **Operator-configurable, no magic numbers.** Targets come from config, with
   defaults that match the readiness specs.
5. **Secret-safe.** A sample never carries the HMAC secret, payloads, or caller
   credentials — only a tool name, outcome discriminant, failure code, timing,
   and correlation identifiers.

## The sink port

Defined in `@herobids/domain/external-backend` (interface + a no-op default; the
domain package stays I/O-free).

```ts
/** One measured external-backend invocation. Flat and serialisable. */
export interface ExternalBackendInvocationSample {
  backendId: string;            // which backend (e.g. "traderton")
  toolName: string;             // the invoked tool
  outcome: 'success' | 'failure' | 'in_progress' | 'transport_error';
  code?: ExternalBackendFailureCode; // present only on 'failure'
  retryable?: boolean;          // present on 'failure' / 'transport_error'
  durationMs: number;           // end-to-end boundary latency for this invoke
  backendDurationMs?: number;   // backend-reported internal time (Phase 2; see below)
  requestId: string;
  correlationId: string;
}

/** The seam. The client calls this once per invocation; it must never throw. */
export interface MetricsSink {
  recordInvocation(sample: ExternalBackendInvocationSample): void;
}
```

- `durationMs` is wall-clock around the single `invoke` (transport encode → send
  → decode → map). It is the end-to-end **boundary** latency per call.
- `backendDurationMs` is the slot for boundary-overhead separation. It stays
  `undefined` until Phase 2 wires a backend-reported duration through the
  contract (see [Boundary overhead](#boundary-overhead-phase-2)).
- `recordInvocation` must be total and non-throwing; a metrics failure must never
  change the result of a trading call.

## The default sink (pino)

The app layer (`apps/worker`, `apps/api`) provides a pino-backed adapter that
emits one line per call with a stable event tag:

```jsonc
{ "evt": "external_backend.invocation",
  "backendId": "traderton", "toolName": "get_price",
  "outcome": "success", "durationMs": 118,
  "requestId": "…", "correlationId": "…" }
```

p50/p95/p99/max, throughput, and error-rate-by-code are computed **offline** from
these lines (log aggregation, or a `jq` script over captured output) for the
first load-test and shadow-mode runs. No `/metrics` endpoint and no aggregation
backend are introduced here — that is a later, deliberate decision, and the port
is what makes it a drop-in.

The domain default is a **no-op** sink, so any `ExternalBackendClient` built
without a sink (existing tests, incidental call sites) keeps working unchanged.

## Configuration

Latency **budgets** are operator config. Because the `externalBackends` key is a
registry (a map parsed into an array), the budgets live in a sibling top-level
block so they are always present even when no backend registry is layered in:

```yaml
# config/default.yaml
externalBackendObservability:
  latencyTargets:
    p50Ms: 200      # readiness default
    p95Ms: 500      # readiness default
    p99Ms: 2000     # readiness default
```

> Doc-path note: the readiness specs name these `externalBackends.latencyTargets.*`.
> We place them under `externalBackendObservability.latencyTargets.*` instead
> because `externalBackends` is a backend **registry** array, not an object that
> can hold scalar budgets. The meaning is identical; only the key path differs.

These values are read by test/load harnesses that assert `p95 ≤ p95Ms`. They are
**not** read on the live request path.

## What each readiness item maps to

| Readiness item (any of the four specs) | Satisfied by | Phase |
|---|---|---|
| p50/p95/p99/max end-to-end latency per tool | `durationMs` in each sample, aggregated offline | 1 |
| Throughput (requests/sec) | sample count per unit time | 1 |
| Error rate by failure code | `outcome` + `code` across samples | 1 |
| Latency budget (operator-configurable targets) | `externalBackendObservability.latencyTargets.*` | 1 |
| Boundary overhead (excl. downstream) | `durationMs − backendDurationMs` | 2 |
| Idempotency-violation count | NOT this layer — see below | n/a |

### Boundary overhead (Phase 2)

Separating boundary cost from downstream venue/provider time needs the backend to
report its own internal handling duration. That is an **additive, backward-
compatible** field on the boundary result contract
(`ExternalBackendToolResultV1`), stamped by the Traderton dispatcher and read by
the client into `backendDurationMs`. The sample shape already carries the field,
so Phase 2 needs no sink or aggregation change — only the contract field and the
two sides that write/read it.

### Idempotency-violation count

This is a write-dedup **correctness** check (same key → one durable write), not an
invocation-timing fact. It belongs with the write-path / shadow-mode verification,
not with this metrics layer, and is intentionally out of scope here.

## Explicitly out of scope (deferred, by design)

- A `/metrics` endpoint or any scrape/export backend (needs a stack decision).
- Shadow-mode equivalence-rate computation (its own validation harness).
- Idempotency-violation counting (write-dedup verification owns it).
- In-process percentile aggregation (offline-from-logs is the minimal start).

## Related

- Readiness spec (generic): [`docs/features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md`](../features/pending/000-capability-foundations/014-operational-readiness-for-external-backends.md)
- Trading extraction phase: [`docs/features/pending/000-capability-foundations/005-trading-capability-extraction.md`](../features/pending/000-capability-foundations/005-trading-capability-extraction.md)
- Phase-1 operational-readiness runbook: [`infra/hetzner/docs/runbooks/phase1-operational-readiness.md`](../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md)
- Configuration layering: [`docs/tech/configuration.md`](./configuration.md)
