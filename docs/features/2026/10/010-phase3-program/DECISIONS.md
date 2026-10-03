# Phase 3 Program — Decision Log

**Status:** living. **Read `ENTRYPOINT.md §5.1` for when to route a decision.**
**Created:** 2026-10-02

## 1. Already settled — do not relitigate

Program-level decisions live in `../../09/24/000-program/DECISIONS.md` (D1–D20).
**D13–D20 were recorded for this phase and are the ones you will trip over.**
Summarised here for orientation only; that file is authoritative.

| # | In one line |
|---|---|
| D4 | ~~MCP deferred~~ — **SUPERSEDED** by D13/D14 + ADR 016. Do not act on it. |
| D6 | Greenfield — no migrations, aliases or dual-run shims. |
| D10 | Step 16 keeps the REST differential vs pinned oracle `1f6978d7…` + load. |
| D11 | Three Traderton skill refs; `github.com/traderton/skills`. |
| D12 | Phase 3 = Steps 10–13; 14/15/16 deferred. **Amended by D14.** |
| **D13** | MCP is the target invocation transport for platform-managed backends. |
| **D14** | `McpTransport` is built in Phase 3 alongside `RestTransport` (operator direction). Pulls a Traderton MCP surface into scope. |
| **D15** | MCP mapping = **native tools**, not an envelope tunnel. `_meta` carries the envelope; signature covers the whole frame; `isError` returns, never throws; `in_progress` via same-key re-issue; Tasks extension not adopted. |
| **D16** | The verified descriptor is the **sole** authority for tool schemas. `tools/list` is cross-checked or ignored. |
| **D17** | Official SDK, **scoped v2 packages**, pinned exact; low-level `Server`, not `McpServer`. |
| **D18** | CF-1 write-path idempotency fixed **before** the rename. |
| **D19** | REST stays the default and the only transport exercised in staging/production. |
| **D20** | Branch commits, **zero pushes**, three repos; `openaidom-skills` read-only. |

### Two decisions where the operator overruled a Contemplator ruling

Recorded explicitly so a fresh agent does not "correct" them back:

- **D14** — a Contemplator ruled `McpTransport` out of Phase-3 scope (seam only).
  The operator overruled: two implementations force the broader design and
  validate the seam. The ruling's substantive findings were **kept** — the mapping
  question had to be decided first (now D15), the `sign.ts` METHOD/PATH collapse
  is real (handled in D15 by signing the whole frame), and `protocol` must not
  ship as a config value that cannot fail fast (handled by building the transport
  in the same phase).
- **D18** — a Contemplator ruled CF-1 should be *characterised and carried* to
  Step 16, not fixed, because a fix is a trading-behaviour change inside a
  scope D12 narrowed. The operator overruled: a reachable duplicate-order path
  with a stable key already in the payload is not worth carrying. The ruling
  flagged the call as ratification-eligible, so this is the invited override, not
  a violation.

## 2. Rejected alternatives (so they are not re-proposed)

| Rejected | Why |
|---|---|
| **Envelope tunnel** (one opaque MCP tool carrying the 005 envelope) | Unusable by any third-party MCP client, so it forfeits the interoperability that motivates ADR 016; and it leaves the transport seam unvalidated, which was the reason for building two transports. |
| **Hand-rolling the MCP protocol subset** | Yields a private dialect resembling MCP without guaranteeing interop — strictly worse than both the SDK and the already-proven REST boundary. |
| **The `@modelcontextprotocol/sdk` monolith** | 17 direct dependencies, including two HTTP frameworks and a second validator. The scoped v2 packages cost a fraction. |
| **`McpServer.registerTool` for the backend surface** | Requires a Standard Schema that can emit JSON Schema; will not accept raw JSON Schema. The descriptor's `inputSchema` already **is** JSON Schema, and D16 makes it authoritative. Use the low-level `Server`. |
| **Adopting the MCP Tasks extension for `in_progress`** | Experimental. Same-key re-issue already resolves both completed and running invocations via the backend's idempotency store. Revisit when Tasks stabilises. |
| **A read-only staging probe as evidence** | Staging runs pre-Phase-3 refs, so it measures code this run did not write; and the documented probe pattern writes a file to an operator-managed host, which is a mutation. See ENTRYPOINT §7. |
| **Two continuity packages (one per repo)** | The shared-contract artefact it would need already exists (the Step 10 plan); traderton has no program convention to host a second package; and splitting authority over a joint seam works against the ownership-boundary invariant. |
| **Amending D10 now for a third differential leg** | Step 16 is deferred and infra-gated. The amendment belongs in Step 16's own verification plan, which already carries an approval gate. Recorded as a conditional trigger instead. |

## 3. Decisions made during this phase (append below)

Format: `P3-n` · date · the decision · why · which invariant it honours · where
recorded. If a decision was routed, name the Contemplator ruling. If it violates
an invariant, contradicts a recorded decision, or accepts an infrastructure
mutation, it needs **human ratification before acting** — say so and stop.

| # | Date | Decision | Rationale | Invariant check | Ruling source |
|---|---|---|---|---|---|
| P3-1 | 2026-10-03 | herobids `run-extra-tests.sh --all` (incl. Tier 6) runs only at G0 and at the closeout G2 run; intermediate per-task verification runs use `run-extra-tests.sh --skip-tier 6` | Tier 6 reaches herobids staging (read-only) and sends a real Telegram message; per-task runs gain nothing from it, and G2 still runs it at default gates at closeout | No infra mutation (`--dry-run`, `AUTOSCALE_DESTRUCTIVE` unset); G2 unchanged | Coordinator (§5.1) |
| P3-2 | 2026-10-03 | `pnpm build` is the type gate in both repos alongside `pnpm lint`; I7's escape-hatch grep covers test files | `pnpm lint` checks a `files: []` tsconfig and tests are in no tsconfig, so lint alone would not catch a type error | G1 strengthened, not weakened | Coordinator |
| P3-3 | 2026-10-03 | Descriptor canonicalization and encoding (Step 10 §3 "Canonicalization and encoding" paragraph). **Before:** "canonical JSON", `publicKey` "PEM/base64" and `maxAge`, undefined. **After:** canonical JSON = RFC 8785 JCS over our value domain (objects, arrays, strings, booleans, null, integers within ±(2^53−1)); transport wrapper `{ descriptor, signature, keyId }`; `signature` = padded base64 ed25519 over `UTF-8(JCS(descriptor))`; `keyId` selects exactly one trusted key with `status` `active`\|`retiring` (no try-every-key); keyIds are unique within trustedDescriptorSigningKeys (rejected at config load); rotation always introduces a new keyId; `publicKey` = PEM SPKI; pin digest = lowercase hex sha256 of `UTF-8(JCS(descriptor))`; `maxAge.seconds` bounds cache age from fetch/verification time, not a check against `issuedAt` (validity is `issuedAt ≤ now < expiresAt`); `tools/list` cross-check = same name set as the union of descriptor tools, per tool `description` string-equal and `inputSchema` JCS-equal, duplicate listed names disagree, compared after exhausting `nextCursor` pagination, `category` and other Tool fields (`title`, `annotations`, `outputSchema`, `_meta`) not compared (proposed; normative when T2.2/T3.2 implement); fixture `expected.reason` codes are normative (T3.1 adopts them as-is) | JCS is the standard deterministic JSON form and coincides with `JSON.stringify` primitives, so both repos implement it in a few lines with no dependency | SEAM §4 change rule followed: Step 10 §3 amended before the T0.4 fixtures, which pin it in both repos with a dir digest (SEAM §3.2); DT1/DT3/DT4 unchanged; no new dependency; no infra mutation | Coordinator (§5.1) |

## 4. Intentional-divergence register (parity-not-liveness)

The program invariant requires that nothing changes trading behaviour without a
recorded note. Log every such change here.

| # | What changed | Why it is intended | Authorised by | Evidence |
|---|---|---|---|---|
| IV-1 | Write-path invocations now carry a **stable** `idempotencyKey` + `requestId` instead of a fresh `randomUUID()` per call | Makes the backend's `replay` branch reachable, closing a duplicate-order path; D15's `in_progress` resolution depends on it | **D18** (operator) | T0.6 characterisation tests |

## 5. Carried-forward obligations (fill at T5.2 — G9 is BLOCKING)

Nothing in this phase substitutes for these. Each needs an evidence path and a
home in `../../09/24/000-program/PROGRESS.md` and the Step-16 obligation list.

| ID | Obligation | Why carried | Lands in |
|---|---|---|---|
| CF-3 | REST differential vs pinned oracle `1f6978d740d45e466cf4149617b8afc1c721e751` — ≥99% payload equivalence per tool category, no novel failure category, zero idempotency violations | D12 deferred; infra-gated | Step 16 |
| CF-4 | Representative load for `submit_decision` + a frequent read tool | D12 deferred; infra-gated; also blocked on CF-5 | Step 16 |
| CF-5 | **No metrics system exists** (no prom-client/otel/statsd/`/metrics`). Every latency/throughput/overhead item is **N/A — not obtainable** until instrumentation is built. Do not promise these numbers | Pre-existing | A separate observability task, prerequisite to CF-4 |
| CF-6 | Staging restart, health-visibility, idempotent-retry-on-writes, deployment/routing rollback. Behavioural resilience is proven for a **read** tool only | Infra-gated | Step 16 |
| CF-7 | **No rollback path exists.** Teardown+rebuild is the accepted pre-launch recovery. Re-evaluate before public launch | Operator decision, pre-launch only | Pre-launch gate |
| CF-8 | Push gate — all `traderton` / `traderton-skills` commits stay local on branches | D20 | Operator approval |
| CF-9 | Real operator-held ed25519 descriptor signing key; registering it is an infra mutation | DT1 + D20 | Operator step |
| CF-10 | **Conditional:** if an MCP transport is reachable when Step 16 is planned, the differential becomes three-legged (oracle / REST / MCP) and **D10 is amended in that step's verification plan** | ADR 016 §Consequences | Step-16 plan authoring |
| CF-11 | Open legal/product dispositions: the `exports-traderton` route, `trading-profile-reconciliation-saga`, `traderton-operator-defaults` (Step 9 Crit 6 Q1). Untouched; they keep working | Deferred with Steps 14–15 | Steps 14–15 |
| CF-12 | Pre-existing failures captured at baseline (T0.2), including the worker launch-latency bug behind `RUN_UNSTABLE_LLM_LATENCY_TESTS` | Pre-existing | Separate |
