---
name: external-backend-genericization
description: >-
  Engineering knowledge for Phase 3 of the herobids ↔ traderton External Backend
  separation: the exact file:line map of client construction sites and hard-coded
  trading branches, the HMAC signing contract and what may not change about it,
  the transport seam and MCP wire mapping, the descriptor trust model, the
  write-path idempotency defect, and the five mandated verification commands.
  Use when working on Steps 11-13, renaming the Traderton client to the generic
  External Backend client, adding a transport (REST or MCP), implementing
  descriptor trust and tool visibility, or publishing Traderton skills.
---

# External Backend Genericization (herobids Phase 3, Steps 11–13)

Facts that cost real time to establish. Read the normative documents for
decisions; read this for coordinates and traps.

- **Execution package:** `docs/features/2026/10/010-phase3-program/ENTRYPOINT.md`
- **Normative contract:** `docs/features/2026/09/24/006-step10-external-backend-contract-and-trust-plan.md`
- **Architecture:** ADR 016 (`docs/tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md`), which supersedes ADR 015 §8
- **Decisions:** `docs/features/2026/09/24/000-program/DECISIONS.md` — D13–D20

> **Secrets rule:** never hardcode HMAC secrets, signing keys or tokens here or
> in any probe. Reference key *names* and read live values from the environment
> at runtime. Generate dev keypairs locally and gitignore the private half.

## 1. Coordinates (saves rediscovery)

| Thing | Where |
|---|---|
| Client + signing + contract (renamed at T1.1) | `packages/domain/src/external-backend/{client,sign,contract}.ts` (was `traderton/`) |
| Subpath export (renamed at T1.1) | `@herobids/domain/external-backend` |
| Config (since T1.3) | `config/default.yaml` `externalBackends.traderton` (map keyed by backendId → `appConfig.externalBackends[]`, schema `packages/domain/src/config/external-backends.ts`) + `tradingBackendId: traderton`; env `TRADERTON_BOUNDARY_{URL,CONSUMER_ID,KEY_ID,TIMEOUT_MS}` are ENV_OVERRIDES rows in both `apps/{api,worker}/src/config.ts`; the secret is the env var named by `caller.hmacSecretRef` (`TRADERTON_BOUNDARY_HMAC_SECRET`), read only by `resolveConfiguredExternalBackend` |
| Agent payload | worker → agent container env `EXTERNAL_BACKEND_CONFIG_JSON` (a `ResolvedExternalBackend`: definition + secret; was `BOUNDARY_CONFIG_JSON`), parsed by `apps/worker/src/external-backend/agent-ports.ts` |
| Tool definition consumed by the LLM | `packages/domain/src/trading/tool-contract.ts:335` → `packages/llm/src/llm-provider.ts:51` |
| Backend dispatcher (reuse, do not reimplement) | `traderton/packages/boundary/src/dispatcher.ts` |
| Backend HTTP app + auth | `traderton/packages/boundary/src/{app,auth}.ts` |
| Backend verifier canonical string | `traderton/packages/boundary/src/auth.ts` — `buildCanonicalString` |
| Skills resolution (live, unpinned) | `apps/worker/src/tools/skills.ts:37` |

### Client construction sites — there are 6, across 3 files

| File | Lines |
|---|---|
| `apps/worker/src/index.ts` | 440, 468, 502, 794 |
| `apps/worker/src/agent.ts` | 938 |
| `apps/api/src/index.ts` | 198 |

Step 9 Crit 2A and the Step 10 plan originally said **5** and listed
`apps/api/src/routes/exports.ts`. **Line 348 there is a COMMENT**, not a
construction. Corrected in Step 10 §1. Roughly 32 further importers are
type-level only.

### The hard-coded trading branches (the real Step 12 surface)

`apps/api/src/routes/skills.ts` · `provider-catalog.ts` ·
`agent-runtime-descriptor.ts` · `apps/worker/src/agent.ts:473` ·
`runtime-composition.ts:700` · `agent-capabilities.ts:18`

Step 9's key finding: the `traderton/` module coupling is **type-level only**.
The genuine work is these branches plus the trust model. Note the file sizes
before planning: `agent.ts` ≈ 4000 LOC, `runtime-composition.ts` ≈ 2300 LOC.

## 2. Traps (each one cost real time)

1. **`sign.test.ts:28-36` is an unfalsifiable guard.** It hand-replicates the
   traderton verifier inline and claims that passing against the replica means
   passing against the real `authenticateRequest`. If traderton's `auth.ts`
   changes, the herobids test **still passes**. Use the shared
   `invocation-signing-vectors.json` fixtures instead (both repos assert a digest
   of the fixture file, so a one-sided edit also fails).
2. **Capture signing fixtures BEFORE the rename.** Captured afterwards they pin
   post-rename bytes and prove nothing about the rename.
3. **`npx skills add` resolves from the REMOTE, live and unpinned.**
   `apps/worker/src/tools/skills.ts:37` spawns it, and `normalizeExternalRef`
   maps `traderton/skills/crypto-trading` → `traderton/skills@crypto-trading`.
   Local `traderton-skills` commits are invisible to it, so **Step 13 cannot be
   verified through the real CLI** — use a local fixture source. The corollary:
   a push there changes agent-facing instructions with no rollback target, so it
   is an infrastructure mutation, not a docs commit.
4. **`run-live-boundary.sh` defaults to STAGING.** When `BOUNDARY_BASE_URL` is
   unset it targets `https://api.staging.traderton.com`, and its suite invokes
   `submit_decision`. It is not one of the five mandated scripts. Never run it in
   this phase.
5. **`docker/xstack.override.yml` makes `TRADERTON_BOUNDARY_URL` overridable.**
   Assert `env | grep TRADERTON_` is empty and `BOUNDARY_BASE_URL` is unset
   before every suite run, or you may test against staging by accident.
6. **"Local" tests are not mocks.** `scripts/shell/tests/run-all-tests.sh` calls
   `ensure_boundary_up` unconditionally and brings up the real traderton stack at
   `localhost:8080` (herobids reaches it at `host.docker.internal:8080` via the
   xstack override). The HMAC triple must match across both repos' `.env`.
7. **No metrics system exists.** No prom-client, otel, statsd or `/metrics`.
   Latency and throughput items are **N/A, not pending**. Do not promise them.
8. **The write-path idempotency key is not threaded.**
   `packages/domain/src/external-backend/client.ts:169-171` defaults `requestId`,
   `idempotencyKey` and `correlationId` to `randomUUID()`, and **no non-test call
   site supplies** the first two. The backend's `replay` branch is therefore
   unreachable, so a caller-level retry of a write can duplicate a side effect. A
   stable key exists in `payload.decisionId`; `write-adapter.ts:71-72,84-85`
   already plumbs both fields. Fixed in Phase 3 before the rename (D18).
9. **Stale paths in the program ENTRYPOINT §4** (now corrected): traderton's docs
   are at `docs/features/initial/CANONICAL-STATE.md` and
   `docs/features/initial/008-decision-process.md` — **not** `docs/CANONICAL-STATE.md`
   or `.../8-decision-process.md`.
10. **macOS has no `timeout`.** Use SSH's `-o ConnectTimeout=…` and, in Node,
    `AbortSignal.timeout(ms)`.

## 3. The signing contract — and what may not change

Canonical string, identical in both repos:

```
METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(rawBody) hex
signature = "sha256=" + HMAC_SHA256(secret, canonical)   # LOWERCASE hex
```

- `PATH` is signed **without** the query string; the backend strips it
  (`toSignedRequest` in `app.ts`).
- Serialize the envelope **once**; hash and sign **those** bytes; send the same
  bytes. The backend retains raw bytes via
  `addContentTypeParser('application/json', { parseAs: 'buffer' })` because the
  hash is over raw bytes, not a re-serialization.
- Headers (lower-cased): `content-type`, `x-traderton-consumer-id`,
  `x-traderton-key-id`, `x-traderton-timestamp`, `x-traderton-signature`,
  `x-request-deadline-at` (must equal the body `deadlineAt`).
- herobids' OAuth helpers use base64url digests. **That convention does not apply
  here** — the verifier checks hex.
- Auth failures return **HTTP 200** with a typed failure envelope, not an HTTP
  error. `authentication.invalid_caller` is permanently **non-retryable**.
- Envelope fields: `contractVersion`, `requestId`, `idempotencyKey`,
  `correlationId`, `issuedAt`, `deadlineAt`, `caller{consumerId,keyId}`,
  `subject`, `toolName`, `payload`.

**Step 10 §5 freezes all of the above for the REST path**, because D10's Step-16
differential depends on byte-identical behaviour. A new transport **reuses**
`buildCanonicalString` and the header set; it does not refactor them. **If a
change to `sign.ts` appears necessary, stop and re-open ADR 016.**

## 4. Transport seam

```
ExternalBackendClient   ← orchestration, ONCE: envelope, idempotency, deadlines,
                          health gating, retry, audit/correlation, result mapping
        │
        ├── RestTransport   POST /internal/v1/tools:invoke   (frozen)
        └── McpTransport    POST <mcpPath>  tools/call       (additive)
```

- Seam interface is **internal** to `packages/domain/src/external-backend/` and
  **not exported** — redirecting it later must not break ~32 importers.
- A transport translates format and returns a result or a typed failure. It owns
  **no** idempotency, retry policy, deadline arithmetic or result mapping.
- `requestId` and `idempotencyKey` are **first-class seam inputs on every
  transport**. Dropping them bakes trap 8 into the abstraction.

## 5. MCP mapping (D15 / Step 10 §2.5)

| Envelope field | Under MCP |
|---|---|
| `toolName` | `params.name` |
| `payload` | `params.arguments` |
| everything else | `params._meta` |

- Signature covers the **entire JSON-RPC frame including `params._meta`**. Method
  and path become constants; the body hash already covers method, tool name,
  arguments and metadata.
- Header↔body assertions retained, reading from `params._meta`.
- `tools/list` served **verbatim from the signed descriptor**, via the
  **low-level `Server`** — `McpServer.registerTool` will not accept raw JSON
  Schema, and the descriptor's `inputSchema` already is JSON Schema. Use
  `fromJsonSchema` from `@modelcontextprotocol/server`.
- **Failures RETURN, never throw.** `isError: true` with the failure envelope in
  `structuredContent`. A thrown handler error becomes a JSON-RPC protocol error
  and the closed `ExternalBackendFailureCode` union is lost. Protocol errors are
  for pre-dispatch framing failures only.
- **`in_progress` needs no status endpoint.** Re-issue `tools/call` with the same
  `idempotencyKey`: the backend's store returns the stored terminal result for a
  completed invocation and an in-progress indication for a running one. Depends
  on trap 8 being fixed first.
- **Per-call timeout from `deadlineAt`.** The SDK client defaults to 60s, which
  would silently override the contract.
- Dependencies: scoped v2 packages, pinned exact — `@modelcontextprotocol/client`
  (herobids), `server` + framework adapter (backend). **Not** the `sdk` monolith
  (17 direct deps, two HTTP frameworks, a second validator).
- **Tasks extension not adopted** (experimental).

**Two spike gates before implementing.** Gate 1: `params._meta` must be inside
the request bytes the client signs — prove it for `initialize`, an SDK-originated
notification, and `tools/call`. **Failure is a hard stop: re-open ADR 016.**
Gate 2: coexistence — the MCP route mounted on the backend's existing app with
`app.test.ts` and `boundary.verification.integration.test.ts` passing
**unmodified**.

## 6. Descriptor trust

Signed ed25519 over canonical JSON, verified against operator-registered public
keys. Pipeline: resolve the definition by the installed skill's source ref (ref ∈
`approvedSourceSkillRefs` AND `enabled`) → fetch per `descriptorPinning` → verify
the signature by `keyId` → check `backendId`, `expiresAt`, pin digest → expose
`tools` + `instructions` for matching refs.

**The verified descriptor is the SOLE authority for tool `name`, `description`,
`inputSchema` and `category` (D16).** A `tools/list` response is cross-checked or
ignored — never a schema source. Rationale: MCP tool descriptions enter the model
context directly, so an unverified list from an order-placing backend is a
tool-poisoning surface. This is also what keeps tool visibility independent of
transport.

Any trust failure (expired, untrusted, mismatched, revoked, or disagreeing with
`tools/list`) degrades the skill to **instruction-only** — never a crash (DT3).

## 7. Verification

Five mandated scripts, all purely local (`run-integration.sh` provisions
throwaway containers on 55432/56379 and tears them down on exit):

```sh
traderton/scripts/shell/tests/run-all-tests.sh --e2e
traderton/scripts/shell/tests/run-extra-tests.sh --all
traderton/scripts/shell/tests/run-integration.sh
herobids/scripts/shell/tests/run-all-tests.sh --e2e
herobids/scripts/shell/tests/run-extra-tests.sh --all
```

Plus `pnpm lint` (tsc --noEmit) and `pnpm build` in both repos.

- Run the **local-boundary assertion** (trap 5) before every suite.
- Do **not** set `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` — it enables three tests
  disabled for a known pre-existing worker launch-latency bug
  (`docs/bug-reports/2026/09/05/001-…`). Out of scope.
- Capture a baseline before any edit. A gate already failing at baseline is a
  pre-existing condition: record it, do not adopt it.

## 8. What this skill does NOT cover

- Deploying, reprovisioning, or changing DNS/TLS/secrets — all gated.
- Staging observation and the boundary resilience checks — see
  `.github/skills/trading-boundary-ops/SKILL.md`. **Phase 3 forbids staging
  confirmation entirely**: staging runs pre-Phase-3 refs, so a probe measures
  code the run did not write, and the probe pattern writes a file to an
  operator-managed host.
- Steps 14 (remove first-party trading), 15 (module move/split) and 16 (final
  staging proof) — all deferred (D12).
- The legal/payment-provider argument. ADR 016 explicitly does not claim protocol
  choice advances it.
