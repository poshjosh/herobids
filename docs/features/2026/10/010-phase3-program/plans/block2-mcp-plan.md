# Phase 3 Block 2 — Step 11b: spike gate 1, backend MCP surface + gate 2, `McpTransport` (T2.1, T2.2, T2.3) — plan

**Status:** plan only, not implemented. No repo was edited while planning.
**Repos / branches:** traderton `phase3-mcp-surface` (T2.2); herobids `phase3-external-backend` (T2.3); T2.1 spikes on local `phase3-mcp-spike` branches (one per repo, cut from those two branches, **never pushed**).
**Lands after:** Block 0 (T0.3 signing vectors + T0.4 descriptor fixtures committed in BOTH repos), T0.6, Block 1 C1–C5 (seam, `transports/select-transport.ts`, `client.invokeAndAwait`, registry with `endpoint.protocol/mcpPath`, D19 loader check).
**Normative:** Step 10 plan §2.4/§2.5/§5; ADR 016; program D13–D20; Phase-3 ENTRYPOINT/TASKS/INVARIANTS/SEAM; traderton `AGENTS.md`, `docs/features/initial/CANONICAL-STATE.md`, `docs/features/initial/008-decision-process.md`.
**Evidence base (outside repos, re-runnable):** `/tmp/mcp-sdk-scratch` — SDK source read; `spike-server.mjs` + `spike-client.mjs` (signed legacy session against a Fastify app with traderton's exact buffer parser); `spike2.mjs` (per-call connect, exchange abort, JSON-RPC error `data`, tools/list round-trip, refused connection); `typecheck/shapes.ts` (planned shapes under the repos' strict tsconfig). Re-run at T2.1 start: `node spike-client.mjs && node spike2.mjs && (cd typecheck && <hb>/node_modules/.bin/tsc -p tsconfig.json)`.

---

## 0. Ground facts

### 0.1 SDK — `@modelcontextprotocol/client@2.3.0`, `@modelcontextprotocol/server@2.3.0` (core 2.3.0; zod 4.6.5 nested)

| Question | Answer (source / observed) |
|---|---|
| Client + custom fetch | `new Client({ name, version })` + `new StreamableHTTPClientTransport(url, { fetch })`. The SDK wraps our fetch in `fetchWithinOrigin` (sets `redirect:'manual'`; follows a same-origin 307/308 by calling our fetch again with the new URL). |
| Era | `versionNegotiation` defaults to `'legacy'` (`DEFAULT_VERSION_NEGOTIATION_MODE`). 2.3.0 also ships the 2026-07-28 "modern" revision (`server/discover`, SDK-injected `_meta` keys, `mcp-method`/`mcp-name` headers) — opt-in only. |
| Frames (observed) | `POST initialize` (protocolVersion `2025-11-25`) → `POST notifications/initialized` (202) → `GET` SSE → per call `POST tools/call`; on timeout/abort `POST notifications/cancelled`. **No DELETE** (`terminateSession` needs a session id; a stateless server never issues one). |
| Exact bytes | Every POST has `init.body = JSON.stringify(message)` — a `string`. Hash `Buffer.from(init.body,'utf8')`, forward the same string: wire bytes = hashed bytes (spike: 7/7 POSTs verified against the raw buffer the traderton-style parser kept). GET has no body. |
| GET SSE | Opened after the 202 to `initialized`; cannot be disabled. `405` → silently "no standalone stream" (no `onerror`); other non-OK → `onerror` only. |
| `mcp-session-id` | Never sent (stateless server returns none). |
| `mcp-protocol-version` | Unsigned, sent after initialize. Server only checks membership (400 if unsupported); in legacy JSON mode it selects nothing → non-material (P3-n28). |
| `_meta` | `callTool({ name, arguments, _meta })`; serialized **verbatim** (frame order `method, params{name, arguments, _meta}, jsonrpc, id`; non-ASCII intact). Legacy era adds nothing (`onprogress` would add `_meta.progressToken`). Server handler sees `request.params._meta` (custom keys preserved) and `ctx.mcpReq._meta`. |
| Timeout | `RequestOptions.timeout` (ms), default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`; `signal` also honoured. Timeout rejects `SdkError` `REQUEST_TIMEOUT` and POSTs `notifications/cancelled`, but in legacy era does **not** abort the in-flight POST (late reply → `onerror` "unknown message ID"). Only `close()` / our own signal aborts fetches. |
| Errors (observed) | refused → `TypeError('fetch failed')`; timeout → `SdkError`; non-2xx → `SdkHttpError` (`.status`); JSON-RPC error → `ProtocolError` (`.code`, `.data?: unknown`, brand `instanceof`); a thrown server handler → `ProtocolError(-32603, <thrown message>)` (message leaks). |
| Server API | `new Server(info, { capabilities: { tools: {} } })` (`@deprecated` in favour of `McpServer`; D17 keeps `Server`). `setRequestHandler('tools/list' \| 'tools/call', handler)` — v2 method strings, no schema objects. Return `{ content, structuredContent, isError? }`; result validated by the era codec (keys kept; **key order may change** — observed `$schema` moved in a tools/list inputSchema → compare JCS, never raw bytes). |
| Stateless + JSON | `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`; one transport + one `Server` per POST (reuse throws). `handleRequest(webRequest, { parsedBody })` skips body reading, so traderton's parser stays the only body reader. Requires `accept` ⊇ `application/json, text/event-stream` + JSON content-type. Notifications → 202. **Never hand it a GET** (stateless GET opens an SSE stream that never ends). |
| `@modelcontextprotocol/fastify@2.0.1` | Exports `createMcpFastifyApp()` (a NEW `Fastify()`), `hostHeaderValidation`, `originValidation`. No parser, no plugin, no protocol code, cannot mount on an existing app; assumes Fastify's default JSON parser. Not needed (P3-n20). |
| `@modelcontextprotocol/node@2.1.1` | `(req,res)` wrapper over the web-standard transport; adds `hono` + `@hono/node-server`. Not needed. |
| Types | Planned shapes (signing fetch, `McpTransport.invoke` + decode with zod-3 schemas, `Server` handlers, `handleRequest(…,{parsedBody})`, `ProtocolError.data`) type-check under strict/Bundler/`noUncheckedIndexedAccess` with **zero** escape hatches (tsc 5.9.3). zod 4 stays under `@modelcontextprotocol/*/node_modules`; app code resolves zod 3.25.76. |

### 0.2 traderton (HEAD `84c3721`)
- `createBoundaryApp(deps)` (`packages/boundary/src/app.ts`): one `addContentTypeParser('application/json',{parseAs:'buffer'})` → `request.body = {parsed, raw, parseError}` on every JSON route; private `headerString`, `toSignedRequest` (strips query), `extractBodyAssertions` (undefined unless `caller.consumerId`, `caller.keyId`, `deadlineAt` are all strings), `identityFor`. The dispatcher is built inside. REST auth failure = HTTP 200 + typed `authentication.invalid_caller` (non-retryable). `dispatch()` never throws for contract failures but **does** throw when the store throws (REST → Fastify 500).
- Ingress `infra/hetzner/Caddyfile.staging`: `api.staging…` proxies every path to `boundary:8080` (HMAC is the gate); `staging.traderton.com` 404s `/internal*`, `/health*`. A route under `/internal/` inherits the site-host block; no Caddy edit (N2).
- Env is read only in `bin.ts`; `packages/worker/src/env-example-drift.test.ts` requires every non-test `process.env['X']` in `.env.example`. Twins: `.env.example`, `infra/hetzner/.env.environment.example`.
- `scripts/shell/tests/run-integration.sh` runs only `boundary.verification.integration.test.ts` (+ args). `run-all-tests.sh --e2e` tier 3 = compose + `dev/boundary-e2e.js`.
- Registry tools needing no seeded state: `get_operator_defaults` (read-config, ownerScopedNoVenue); `remove_watch` (write-memory, ownerScopedNoVenue; an unknown uuid → deterministic terminal `validation.invalid_payload` "watch … not found", stored and replayable).

### 0.3 herobids (after Block 1)
- Seam per block1 §3; `select-transport.ts` is the only file naming a transport; `poll()` returns the typed unsupported failure without `lookupStatus`; client's `awaitTerminal` re-issues the same invocation; D19 loader rejects `mcp` outside development/test.
- Domain subpath is node-only; the main barrel never imports it; `tool-contract.ts` type-imports `client.js` only. Images use `pnpm deploy --prod` → new domain deps ship with no Dockerfile change. herobids drift test excludes `*.test.ts`.
- xstack: `scripts/shell/run/boundary.sh` brings up traderton's compose (project `traderton_xstack`) with the herobids-owned overlay `docker/traderton-xstack.override.yml`; boundary at `http://localhost:8080`.

---

## 1. Decisions to record (Phase-3 `DECISIONS.md` §3; take the next free numbers — shown as n19…)

Traderton-local choices (n20–n27) are **proposals**: T2.2 routes them through traderton 008 (§3.1). If the decision agent rules differently, its ruling wins and §2.5 of Step 10 follows it.

| # | Decision | One-line rationale |
|---|---|---|
| n19 | Era = legacy Streamable HTTP (2025-11-25): client default negotiation; server = per-request low-level `Server` + stateless JSON web-standard transport, not `createMcpHandler` | It is the SDK's client default and what MCP clients speak today; an `auto` modern client falls back to it after `server/discover` → -32601. Modern serving is a later additive change on the same route |
| n20 | Backend adds `@modelcontextprotocol/server@2.3.0` only — no `/fastify`, no `/node` adapter | The Fastify adapter only creates a new app + Host/Origin hooks and contains no protocol code; nothing is hand-rolled, so D17's intent holds. ADR 016 §8 gets a dated clarification note |
| n21 | Path `POST /internal/v1/mcp` on the existing listener; path major `1` | Same listener + existing private prefix = not infra (N2); the site host already 404s `/internal/*` |
| n22 | Off by default: `BOUNDARY_MCP_ENABLED=true` mounts it; `BOUNDARY_MCP_DESCRIPTOR_PATH` (optional) feeds tools/list; unset → `[]`; path set while disabled, unreadable or invalid file → startup error | No new staging surface unless an operator opts in; tools/list never invents schemas (D16) |
| n23 | Every POST authenticated by unmodified `authenticateRequest` (method `POST`, path `MCP_PATH`, raw bytes). Header↔`_meta` assertions only for `tools/call`, using REST's exact extraction semantics; the client sends `x-request-deadline-at = envelope.deadlineAt` on every frame of an exchange | One canonical string, one verifier, REST-identical assertion semantics; an exchange has exactly one deadline |
| n24 | GET/DELETE on the MCP path → 405 `Allow: POST`, no auth, no side effect; no sessions; JSON-RPC batches → -32600 | Stateless endpoint; the SDK treats 405 as "no stream"; batching left the spec in 2025-06-18 and would dodge per-frame assertions |
| n25 | `tools/call` result: `structuredContent` = the 005 response verbatim (`TradertonToolResultV1`, or the status shape); `isError: true` iff `outcome.kind === 'failure'`; `content` = one text block with the same JSON; `in_progress` = status shape, no `isError` | One rule for success/failure/in_progress; the closed union, identity and replay identity survive; the discriminator is REST's (`'state' in body`) |
| n26 | Pre-dispatch failures: `tools/call` auth failure → `isError` result carrying `authentication.invalid_caller` (identity from `_meta`); other request frames → HTTP 200 JSON-RPC error `-32000` with `data` = the 005 failure result; notifications / unparseable body → HTTP 401 JSON-RPC error `id:null` with the same `data`; invalid JSON → -32700 (after auth); a dispatcher **exception** → logged, rethrown as sanitized `ProtocolError(-32603, 'boundary internal error')` | Closed-union codes stay closed-union on every frame that can carry them. An exception's outcome is unknown: herobids maps it to `transport_error` (same-key re-issue) exactly as REST maps the 500; a terminal code would end the key's life (P3-1) |
| n27 | `tools/call` dispatches any registry tool (not restricted to descriptor tools) | Execution authority = registry, as on REST; visibility authority = verified descriptor in herobids (D16) |
| n28 | Unsigned headers (`mcp-protocol-version`, `accept`, `content-type` beyond the verifier's check) are non-material | They can only cause rejection; the signed body covers method, name, arguments and `_meta` |
| n29 | `McpTransport` connects per invocation (connect → callTool → close); the whole exchange is bounded by one `AbortSignal.timeout(attempt.timeoutMs)` threaded into fetch, `connect` and `callTool` | Stateless backend, no shared state, `close()` reaps the un-aborted legacy POST; cost (+2 POST, +1 GET per call) is acceptable for a dev/test-only transport (D19). Re-evaluate before any staging use (carried) |
| n30 | The client SDK is loaded lazily (`import()` on first MCP invoke); only `import type` at module top | REST-only processes (all of staging/prod, D19) never execute SDK code |
| n31 | **P3-n18 resolved:** attempt timeout = `min(requestTimeoutMs, deadlineAt − now)`; `requestTimeoutMs` when already expired (the backend answers `deadline.expired`). One client method, both transports → **IV-2** | Satisfies §2.5 ("driven from deadlineAt", never the SDK 60 s) without a transport-aware client; for REST it only ever shortens an attempt |
| n32 | MCP reconcile limit (t0.6 R1): no non-executing lookup on MCP; past `deadlineAt` a write's outcome stays unknown unless the caller routes that tool over REST (`toolProtocolOverrides`) | D15 rejects a status tool/Tasks; REST stays the staging/prod path (D19); carried into CF-6 |
| n33 | The herobids fake boundary's MCP face uses the real `@modelcontextprotocol/server@2.3.0` (apps/worker devDependency) | Proves client↔server SDK interop in the default unit tier; a hand-rolled JSON-RPC fake is the drift class SEAM §2 warns about |
| n34 | Gate-1 spike tests are promoted into the permanent suites; spike branches kept, unpushed, as evidence | Spike code that passes is the best regression test; deleting a branch needs operator OK |
| n35 | Step 10 §2.5 stays the single normative wire spec (SEAM §1); traderton 005 gets a pointer section with traderton-local operational facts only | A second prose copy is drift; executable guards: traderton SDK route test, herobids xstack leg, T0.3 vectors |
| n36 | Cross-stack transport-parity leg in herobids `run-all-tests.sh` step 5 (hard-coded `localhost:8080`; MCP enabled through the herobids-owned xstack overlay) | Real herobids `McpTransport` → real traderton route → real Postgres, without touching G3/D19 |
| n37 | MCP `arguments` must be an object; a non-object payload → `transport_error` without I/O | MCP schema requirement; no registered tool has a non-object payload |

**IV-2 (divergence register §4):** "Per-attempt timeout is bounded by the time remaining to `deadlineAt` (REST and MCP); previously a flat `requestTimeoutMs`." Why: §2.5 deadline semantics, no overrun past the caller's deadline. Authorised by: §2.5 + D14. Evidence: client tests in §4.6.

Needs ratification? None violates an invariant or contradicts a recorded decision. n20 narrows the descriptive half of D17 ("+ framework adapter") while keeping its operative half — flag it in the TASKS running notes for the operator's after-the-fact review; it is not an escalation.

---

## 2. T2.1 — spike gate 1 (HARD STOP if it fails)

### 2.1 Design (cross-repo in one test is impossible; three honest legs)

| Leg | Where | What |
|---|---|---|
| **A** (decisive) | traderton `phase3-mcp-spike` | `@modelcontextprotocol/server@2.3.0` (dep) + `@modelcontextprotocol/client@2.3.0` (devDep) in `packages/boundary`. Minimal MCP route per §3 on the **real** `createBoundaryApp`, `app.listen({ port: 0 })`. SDK client whose fetch middleware calls traderton's dev signer `signRequest(identity, { method, path: MCP_PATH, rawBody: Buffer.from(init.body ?? '', 'utf8'), deadlineAt })` (reuses `auth.ts` `buildCanonicalString`). An `onRequest`-free recorder in the route keeps `{ rawHex, sha256, parsed }` per POST; the middleware records `{ body, sha256 }` per send. |
| **B** | herobids `phase3-mcp-spike` | `@modelcontextprotocol/client@2.3.0` in `packages/domain`. The planned `createSigningFetch` (§4.2) using herobids' unmodified `signRequest`, against a recording `node:http` server answering initialize/202/405/tools-call. Writes the recorded frames (bytes, headers, timestamp) to `/tmp/mcp-gate1-frames.json` (outside repos). |
| **Bridge** | traderton spike test | Reads `/tmp/mcp-gate1-frames.json` (skip if absent) and verifies every herobids-signed POST with the **real** `authenticateRequest` at `now = Date.parse(timestamp)`, path `MCP_PATH`, plus `extractBodyAssertions(params._meta)` for tools/call. Same test-only secret in A and B. |

Spike test names (promoted later, n34): leg A → `packages/boundary/src/mcp/mcp.sdk.test.ts`; leg B → the signing cases of `packages/domain/src/external-backend/transports/mcp-transport.test.ts`. The bridge stays spike-only (superseded by the xstack leg, n36).

### 2.2 Gate-1 PASS (every item must hold)
1. With default client options the observed sequence is `POST initialize`, `POST notifications/initialized`, `GET` (→405), `POST tools/call`; every POST's `init.body` is a `string` at the middleware (A and B).
2. Every POST passes the real route's `authenticateRequest` (POST, `MCP_PATH`, raw bytes): initialize and tools/call return JSON-RPC results; the notification gets 202 (A).
3. For tools/call, `sha256(bytes received by the server) === sha256(bytes the middleware hashed)` and `JSON.parse(raw).params._meta` deep-equals the 8 envelope fields sent; the handler's `request.params._meta` equals the same object (A).
4. Tamper controls rejected as `authentication.invalid_caller`: one byte flipped inside the `_meta` region after signing; `_meta.deadlineAt` ≠ `x-request-deadline-at`; `_meta.caller.keyId` ≠ header (A).
5. A client timeout's SDK-originated `notifications/cancelled` is signed and authenticates (A).
6. herobids middleware headers === `signRequest(identity, { method:'POST', path: mcpPath, rawBody, timestamp, deadlineAt })` and the forwarded body is the identical string (B); the bridge accepts every B frame (bridge).
7. `pnpm build` + `pnpm lint` green in both spike branches; `git diff <base>...HEAD -- '*.ts' | rg '^\+.*(\bas unknown as\b|@ts-ignore|@ts-expect-error|: *any\b)'` → nothing; `pnpm why zod -r` → every `@traderton/*` / `@herobids/*` package on 3.25.x, 4.x only under `@modelcontextprotocol/*`.

### 2.3 Gate-1 FAIL → 🚫 T2.1 (hard stop 3)
Any of: an SDK-originated POST whose body is not a string or that bypasses the custom fetch; `_meta` absent, rewritten or re-serialized between the caller's object and the signed bytes; any POST that cannot authenticate under **unmodified** `authenticateRequest`/`buildCanonicalString`; any apparent need to edit `sign.ts`/`auth.ts` canonicalization, header names or body serialization. Then: mark T2.1 🚫, write the failing assertion + spike SHAs into TASKS running notes, append "re-open ADR 016 (gate 1)" to DECISIONS, do **not** start T2.2/T2.3, report to the operator (ENTRYPOINT §6 — wait). No workaround (no body re-serialization in middleware, no unsigned frames, no custom transport).
**Not failures** (record only): the GET/405, unsigned `mcp-protocol-version` (n28), nested zod 4, `Server` deprecation tag. Item 7 failing is a T2.1 exit defect to fix, not hard stop 3.

### 2.4 Steps + record
1. G3 check. `git -C <repo> switch -c phase3-mcp-spike` in each repo from the phase3 branch HEAD (record base SHAs).
2. Add deps (exact pins), write legs B then A + bridge; run; capture output to `herobids-traderton/phase3-logs/t2.1-*.log`.
3. Commit on each spike branch: `spike(boundary): MCP gate-1 signing spike (Phase 3 T2.1) — not for merge` / `spike(domain): MCP client signing middleware gate-1 spike (Phase 3 T2.1) — not for merge`. Never push.
4. Switch back to the phase3 branches. herobids TASKS: T2.1 ✅ (or 🚫) + spike SHAs + per-item PASS evidence; DECISIONS n19, n34.

```sh
# traderton spike
pnpm install && pnpm build && pnpm lint
pnpm exec vitest run packages/boundary/src/mcp
pnpm why zod -r
# herobids spike
pnpm install && pnpm --filter @herobids/domain build && pnpm lint
pnpm exec vitest run packages/domain/src/external-backend/transports
pnpm why zod -r
```

---

## 3. T2.2 — traderton MCP surface + gate 2 (branch `phase3-mcp-surface`)

### 3.1 Traderton's own process (author before code)
- **Decision checkpoint (008 §1 trigger "cross-repo contract: adds boundary surface").** Author `docs/features/2026/10/<DD>/001-mcp-boundary-surface/002-decision-brief-mcp-binding.md` from the 008 §2 template, **neutral, no lean** (do not paste §1's recommendations): strategic objective; tactical = Phase-3 T2.2; rules (copy-never-author → MCP route is authored *boundary machinery*, like F1; parity; legal isolation; merge gate); prior decisions (vision #6 "M1 → M2 REST → MCP/skills later", 005, F D1–D5, herobids D13–D17 + ADR 016 as consumer-side givens); the neutral question; code facts from §0.2; unranked options for path, enablement, pre-dispatch failure encoding, dispatcher-exception handling, tools/list source, tool restriction; unknowns. Route it to a fresh Contemplator per 008 §3 with the §9.3 escalation-gate instruction verbatim. Expected gate result: "settled within the rules" (additive, off by default, honours isolation). If the agent marks anything *pending ratification*, proceed (008 §6.3) and add an ESCALATIONS row in herobids.
- `docs/features/2026/10/<DD>/001-mcp-boundary-surface/001-plan.md` — traderton-side plan: points to herobids Step 10 §2.5 + ADR 016 for the mapping, lists files/tests/commits below.
- `docs/features/initial/004-decision-log.md` — append the ruling + reasoning.
- `docs/features/initial/001-parity-ledger.md` — journal entry: "MCP binding, additive, off by default; REST bytes/behaviour unchanged; no parity impact."
- `docs/features/initial/005-consumer-boundary-contract.md` — new short section "MCP binding (additive, Phase 3)": endpoint, enablement env, the statement that field mapping and result encoding are normative in herobids Step 10 §2.5 (n35), and the traderton tests that pin it.
- `docs/features/initial/CANONICAL-STATE.md` §2 — one line: MCP binding on branch `phase3-mcp-surface`, not merged, off by default; §8 pointer to the feature folder.
- `.env.example` + `infra/hetzner/.env.environment.example` — the two new keys (§3.4).

### 3.2 Files

| File | Change |
|---|---|
| `packages/boundary/src/request-material.ts` | **NEW (pure move from app.ts):** `ParsedJsonBody`, `headerString`, `toSignedRequest`, `extractBodyAssertions`, `identityFor` — bodies byte-identical |
| `packages/boundary/src/app.ts` | Import the moved helpers (route handler text unchanged); `BoundaryAppDeps.mcp?: McpSurfaceConfig`; after the REST/status/health routes: `if (deps.mcp) registerMcpRoute(app, { config: deps.config, now, dispatcher, surface: deps.mcp });`. Parser block untouched |
| `packages/boundary/src/mcp/constants.ts` | `MCP_PATH = '/internal/v1/mcp'`, `MCP_PATH_MAJOR = '1'`, `MCP_SERVER_INFO = { name: 'traderton-boundary', version: '0.0.1' }` |
| `packages/boundary/src/mcp/descriptor-tools.ts` | `McpToolDefinition { name; description; inputSchema: { type: 'object'; [k: string]: unknown } }`; Zod `DescriptorWrapperSchema` (`{ descriptor: { backendId, sourceSkills: [{ ref, tools: [{ name, description, inputSchema, category }] }] }, signature, keyId }`, passthrough); `projectDescriptorTools(wrapper: unknown)` → `ok(tools)` = union across `sourceSkills`, deduped by name, `category` dropped; `err('mcp.descriptor_invalid' \| 'mcp.descriptor_tool_conflict' \| 'mcp.descriptor_schema_not_object')`. Serves, never verifies the signature (herobids is the verifier, DT1) |
| `packages/boundary/src/mcp/surface-config.ts` | `McpSurfaceConfig { tools: readonly McpToolDefinition[] }`; `resolveMcpSurfaceConfig(env: { enabled?: string; descriptorPath?: string }, readFile: (path: string) => string): McpSurfaceConfig \| undefined` — `enabled` ∈ {undefined,'false'} → undefined; `'true'` → tools from the file or `[]`; anything else, a path while disabled, or a bad file → throws (entry-point fail-fast) |
| `packages/boundary/src/mcp/tool-call.ts` | `ENVELOPE_META_KEYS = ['contractVersion','requestId','idempotencyKey','correlationId','issuedAt','deadlineAt','caller','subject']`; `envelopeFromToolCall({ name, arguments, _meta })` → `{ <the 8 keys present in _meta>, toolName: name, payload: arguments }` (other `_meta` keys ignored; dispatcher's strict schema validates); `toCallToolResult(response: TradertonInvokeResponseV1)` per n25 |
| `packages/boundary/src/mcp/server.ts` | `createMcpServer({ tools, dispatch, preDispatchFailure? })` → `Server` with tools/list (`{ tools: [...tools] }`) and tools/call: `preDispatchFailure` → `toCallToolResult(failureResult(identityFor(_meta), code, message, false))`; else `toCallToolResult(await dispatch(envelopeFromToolCall(params), MCP_PATH_MAJOR))`; dispatch exception → log `{ requestId, toolName, err }`, throw `new ProtocolError(INTERNAL_ERROR, 'boundary internal error')` (n26) |
| `packages/boundary/src/mcp/jsonrpc.ts` | `isToolsCallFrame`, `requestIdOf`, `isNotificationFrame`, `jsonRpcErrorBody(id, code, message, data?)` |
| `packages/boundary/src/mcp/route.ts` | `registerMcpRoute(app, deps: { config; now; dispatcher: Pick<ToolInvocationDispatcher,'dispatch'>; surface })` — flow below |
| `packages/boundary/src/bin.ts` | `const mcp = resolveMcpSurfaceConfig({ enabled: process.env['BOUNDARY_MCP_ENABLED'], descriptorPath: process.env['BOUNDARY_MCP_DESCRIPTOR_PATH'] }, (p) => readFileSync(p, 'utf8'));` → `createBoundaryApp({ …, ...(mcp ? { mcp } : {}) })`; log mounted/tool count |
| `packages/boundary/src/index.ts` | export `MCP_PATH`, `type McpSurfaceConfig`, `type McpToolDefinition` |
| `packages/boundary/package.json` | dependencies `"@modelcontextprotocol/server": "2.3.0"`; devDependencies `"@modelcontextprotocol/client": "2.3.0"` (SDK route test only) + `pnpm-lock.yaml` |
| `scripts/shell/tests/run-integration.sh` | append `packages/boundary/src/boundary.mcp.verification.integration.test.ts` to the vitest line |

**POST `MCP_PATH` flow** (`route.ts`):
1. `body = request.body as ParsedJsonBody`; `raw = body.raw`; `parsed = body.parseError ? undefined : body.parsed`.
2. `toolsCall = isToolsCallFrame(parsed)`; `meta = toolsCall ? parsed.params._meta : undefined`.
3. `authenticateRequest(toSignedRequest(request, raw), config, now(), toolsCall ? extractBodyAssertions(meta) : undefined)` — before anything else, exactly like REST.
4. Auth failure: tools/call → step 7 with `preDispatchFailure`; request frame with an id → 200 + `jsonRpcErrorBody(id, -32000, msg, failureResult({requestId:'',correlationId:''}, code, msg, false))`; notification/unparseable → 401 + same body with `id: null`.
5. `parseError` → 400 -32700; `Array.isArray(parsed)` → 400 -32600 "batch requests are not supported".
6. Build `Headers` from `request.headers` (string values; arrays joined `, `).
7. Per request: `server = createMcpServer(...)`, `transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`; `await server.connect(transport)`; `res = await transport.handleRequest(new Request(\`http://boundary${MCP_PATH}\`, { method: 'POST', headers }), { parsedBody: parsed })`; copy `res.status` + headers; send `await res.text()` (empty for 202); `finally await server.close()`.
8. `app.route({ method: ['GET','DELETE'], url: MCP_PATH })` → 405, `allow: POST`, body `jsonRpcErrorBody(null, -32000, 'Method not allowed.')`. No auth.

### 3.3 Gate 2 (coexistence) — all must hold
- `app.test.ts`, `boundary.verification.integration.test.ts`, T0.3 `signing-vectors.test.ts` (incl. its through-the-real-app block) and T0.4 `descriptor-conformance.test.ts` pass **unmodified** (`git diff "$T2_BASE" -- <those files>` empty).
- Parser and REST handler blocks textually identical to base:
```sh
# sed BRE: '(' is literal. Each diff must print nothing.
for range in '/app.addContentTypeParser(/,/^  );/p' '/app.post(INVOKE_PATH/,/^  });/p' '/app.get(STATUS_PATH/,/^  });/p'; do
  diff <(git show "$T2_BASE":packages/boundary/src/app.ts | sed -n "$range") <(sed -n "$range" packages/boundary/src/app.ts) && echo "identical: $range"
done
```
- `createBoundaryApp` without `mcp` registers no MCP route (test below).

### 3.4 Config / env (operator env, read only in `bin.ts`)
```
BOUNDARY_MCP_ENABLED=false            # mount POST /internal/v1/mcp on the boundary listener (true|false); default false
BOUNDARY_MCP_DESCRIPTOR_PATH=         # optional; path to the signed External Backend Descriptor wrapper JSON served verbatim by MCP tools/list; requires BOUNDARY_MCP_ENABLED=true; unset = empty tools/list
```
Both twins (`.env.example`, `infra/hetzner/.env.environment.example`), same change. Local `docker-compose.yml`: no change (operators set `.env`); the herobids xstack overlay sets `BOUNDARY_MCP_ENABLED` (§4.8). Forward note for T3.2/T4.2: if herobids adopts the tools/list cross-check, the backend's descriptor path must point at the same signed descriptor herobids verifies, or the cross-check degrades to instruction-only by design.

### 3.5 Tests (behaviour-named)
`packages/boundary/src/mcp/route.test.ts` (`app.inject`, frames signed with `dev/sign.ts`, fake store as in `app.test.ts`, local copies — never import from `app.test.ts`):
- `does not mount the MCP route unless an MCP surface is configured`
- `authenticates every POST frame with the shared canonical string over the raw body`
- `rejects an unsigned initialize with a JSON-RPC error whose data is the authentication.invalid_caller failure`
- `rejects an unsigned notification with 401 and dispatches nothing`
- `returns authentication.invalid_caller as an isError tool result when a tools/call signature does not verify`
- `rejects a tools/call whose _meta caller or deadline disagrees with the signed headers`
- `dispatches tools/call through the existing dispatcher with the envelope rebuilt from name, arguments and _meta`
- `ignores _meta keys outside the envelope field set`
- `returns the dispatcher failure envelope in structuredContent with isError true and the code intact`
- `returns the in_progress status shape without isError for a same-key re-issue while the first is running`
- `returns the stored terminal result for a same-key re-issue after completion`
- `returns validation.invalid_payload for a reused key with a changed payload`
- `surfaces a dispatcher exception as a sanitized JSON-RPC internal error, not a tool result`
- `answers GET and DELETE with 405 and no side effect`
- `rejects JSON-RPC batches as invalid requests`
- `answers an authenticated notification with 202`
- `a cancellation notification does not abort a dispatched invocation`
- `serves tools/list from the configured descriptor, JCS-equal under the D16 cross-check rule` (T0.4 `valid.json` + `tools-list-agrees.tools-list.json`)
- `serves an empty tools/list when no descriptor is configured`

`mcp/descriptor-tools.test.ts`: `projects the union of descriptor tools across source skills`; `drops category and keeps name, description and inputSchema`; `rejects duplicate tool names whose definitions disagree`; `rejects a tool whose inputSchema root is not an object schema`; `rejects a malformed wrapper`.
`mcp/surface-config.test.ts`: `stays unmounted when BOUNDARY_MCP_ENABLED is unset or false`; `mounts with an empty tool list when enabled without a descriptor`; `rejects a non-boolean BOUNDARY_MCP_ENABLED`; `rejects a descriptor path while MCP is disabled`; `fails fast on an unreadable or invalid descriptor file`.
`mcp/mcp.sdk.test.ts` (promoted leg A; real listening app; SDK client devDep + dev signer):
- `initialize, notifications/initialized and tools/call from the official client all authenticate against the boundary`
- `the bytes the client signs contain params._meta exactly as sent and the server receives the same bytes`
- `a byte flipped inside _meta after signing is rejected as authentication.invalid_caller`
- `the client's SSE GET is answered 405 and the session stays usable`
- `a client-side timeout's notifications/cancelled is signed and accepted`
- `an isError tool result reaches the client with the closed failure code and retryable flag intact`
- `tools/list from the client agrees with the descriptor under the cross-check rule`
`boundary.mcp.verification.integration.test.ts` (real Postgres + Redis, `DATABASE_URL`/`REDIS_URL`-gated like its REST sibling; real app on a port; SDK client):
- `the same signed create_bot over MCP twice persists exactly one bot row and one invocation`
- `reusing the key with a changed payload over MCP returns validation.invalid_payload with no second bot row`
- `a key first used over REST replays over MCP without a second execution`
- `an already-past deadline over MCP returns deadline.expired and persists nothing`

### 3.6 Commits (traderton, `phase3-mcp-surface`)
| # | Message | Content |
|---|---|---|
| TC1 | `docs(boundary): MCP binding decision brief, ruling and plan (Phase 3 T2.2)` | 008 brief, 004 ruling, feature plan |
| TC2 | `refactor(boundary): move signed-request material out of app.ts (Phase 3 T2.2)` | pure move; app/verification/vector tests green unmodified |
| TC3 | `feat(boundary): MCP route over the existing dispatcher, off by default (Phase 3 T2.2)` | deps, `mcp/*`, app/bin/index, env twins, unit + SDK tests, 005/001/CANONICAL-STATE |
| TC4 | `test(boundary): MCP idempotency verification against real Postgres (Phase 3 T2.2)` | integration test + `run-integration.sh` |

```sh
# G3 first
T2_BASE=$(git rev-parse HEAD)            # before TC2
pnpm install && pnpm build && pnpm lint
pnpm exec vitest run packages/boundary
pnpm exec vitest run packages/worker/src/env-example-drift.test.ts
scripts/shell/tests/run-integration.sh                   # both verification suites, real Postgres
git diff "$T2_BASE" -- packages/boundary/src/app.test.ts packages/boundary/src/boundary.verification.integration.test.ts   # empty
# §3.3 block-identity loop; I7 escape-hatch grep on the branch diff; pnpm why zod -r
scripts/shell/tests/run-all-tests.sh --e2e && scripts/shell/tests/run-extra-tests.sh --all   # vs G0
```

---

## 4. T2.3 — herobids `McpTransport` (branch `phase3-external-backend`)

### 4.1 Doc-first (SEAM §4) — before code
Amend Step 10 plan §2.5 with the wire details as ruled at TC1 (n21–n26, n28; legacy era n19; GET/DELETE 405; no batches; per-exchange deadline header), §1 example `mcpPath: "/internal/v1/mcp"`, and the P3-n18 resolution (n31); ADR 016 §Decision 8 dated note (n20); SEAM §5 gate results; DECISIONS n19–n37 + IV-2; TASKS T2.1 result. Commit HC1. No shared fixture changes (n35: T0.3 vectors already link signer↔verifier on arbitrary bytes; adding an MCP vector would churn both digests without new information).

### 4.2 Files

| File | Change |
|---|---|
| `packages/domain/package.json` | dependencies `"@modelcontextprotocol/client": "2.3.0"` (+ lockfile) |
| `transports/mcp-signing-fetch.ts` | `createSigningFetch({ identity, signedPath, deadlineAt, signal, fetchImpl = fetch }): typeof fetch` — refuse when `new URL(input).pathname !== signedPath` (no signing of redirect targets); `body` must be `undefined \| null \| string` else `TypeError` (gate-1 tripwire); `signRequest(identity, { method: (init.method ?? 'GET').toUpperCase(), path: signedPath, rawBody: Buffer.from(body ?? '', 'utf8'), deadlineAt })` merged into `new Headers(init.headers)`; `signal = init.signal ? AbortSignal.any([init.signal, signal]) : signal`; forward the **same** body string. `sign.ts` untouched (I4) |
| `transports/mcp-wire.ts` | zod-3 `ToolResultWireSchema` (closed 10-code enum, `satisfies` the `ExternalBackendFailureCode` union) + `StatusWireSchema`; `decodeCallToolResult(result: CallToolResult): TransportOutcome` — status `in_progress` → `in_progress`; status `terminal` → `terminal(result)`; ToolResultV1 with `(isError === true) === (kind === 'failure')` → `terminal`; anything else → `transport_error 'boundary returned an unreadable response'`. `decodeMcpError(err, sdk): TransportOutcome` — `ProtocolError` with `data` parsing as a failure result → `terminal(data)`; `SdkHttpError` → ``boundary returned status ${err.status}``; else `'request to boundary failed'`. Messages = RestTransport's |
| `transports/mcp-transport.ts` | `export class McpTransport implements ExternalBackendTransport` (no `lookupStatus`), ctor `{ baseUrl, mcpPath, identity }`; `invoke(invocation, attempt)`: n37 guard → `sdk = await loadMcpClientSdk()` (cached `import()`, n30) → `exchange = AbortSignal.timeout(attempt.timeoutMs)` → `new sdk.Client({ name: 'herobids', version: '1.0.0' })` + `new sdk.StreamableHTTPClientTransport(new URL(baseUrl + mcpPath), { fetch: createSigningFetch({ identity, signedPath: mcpPath, deadlineAt: invocation.deadlineAt, signal: exchange }) })` → `connect(transport, { signal: exchange, timeout: attempt.timeoutMs })` → `callTool({ name: invocation.toolName, arguments: payload, _meta: { contractVersion, requestId, idempotencyKey, correlationId, issuedAt, deadlineAt, caller, subject } }, { signal: exchange, timeout: attempt.timeoutMs })` → `decodeCallToolResult`; `catch` → `decodeMcpError`; `finally await client.close().catch(() => undefined)`. Never throws; never calls tools/list (D16) |
| `transports/select-transport.ts` | factory `mcp: () => new McpTransport({ baseUrl, mcpPath: requireMcpPath(options), identity })`; missing `mcpPath` → throw `external_backend.mcp_path_missing` at construction |
| `client.ts` | `private attemptTimeoutMs(deadlineAt: string): number` (n31) used by `invoke`, the `invokeAndAwait` re-issues and each `lookupStatus` poll; nothing else changes |
| `config/default.yaml` | comment only: `# mcpPath: /internal/v1/mcp   # required when protocol or any override is mcp` |

Composition with Block 1: no change to `transport.ts`, the client's orchestration, the worker adapters or `index.ts` (I2/I3). `requestId`/`idempotencyKey` travel in `_meta` unchanged (I5). MCP `in_progress` → client's no-`lookupStatus` re-issue loop (never past `deadlineAt`, t0.6 R1); `poll()` stays the typed unsupported failure on MCP tools (n32).

### 4.3 Fake boundary MCP face (`apps/worker/src/external-backend/__tests__/fake-idempotent-boundary.ts`)
- devDependency `"@modelcontextprotocol/server": "2.3.0"` in `apps/worker/package.json` (n33).
- Same `node:http` server and transport-independent core. New route `POST FAKE_MCP_PATH` (`'/fake/v1/mcp'`, deliberately not traderton's path — proves herobids reads the path from config): read raw body → record `{ method, rawBody, headers }` → `JSON.parse` → per-request `Server` (tools/call → envelope from `_meta` → core `handleInvoke` → n25 encoding) + stateless JSON transport `handleRequest(new Request(url, { method, headers }), { parsedBody })` → write status/headers/body. `GET`/`DELETE` → 405.
- Controls extended: `loseNextToolCallResponseAfterExecution()` (destroy the socket of the next tools/call POST only, after the core completed), `holdNextExecution()` unchanged, `respondNextWith(result)` (programmed outcome for code/retryable mapping), `rejectNextAuthentication()` (REST: 200 + `authentication.invalid_caller`; MCP: initialize → JSON-RPC error with failure `data`), `recordedFrames()`.

### 4.4 Contract suites parameterised over `['rest','mcp']` (G7)
- `write-idempotency.contract.test.ts` (T0.6): append `{ transport: 'mcp', createHarness: createMcpHarness }` (`protocol: 'mcp'`, `mcpPath: FAKE_MCP_PATH`); (a), (b), (c1), (c2), (c3) run on both; the status-endpoint block stays REST-only (D15).
- NEW `apps/worker/src/external-backend/transport-parity.contract.test.ts`, `describe.each` over both:
  - `preserves every closed-union failure code and its retryable flag verbatim over $transport`
  - `returns success payloads unchanged over $transport`
  - `reports a running same-key invocation as in_progress and then resolves it over $transport`
  - `maps a refused connection to transport_error within the attempt timeout over $transport`
  - `maps a backend that never answers to transport_error at the attempt timeout without hanging over $transport`
  - `executes once when a same-key re-issue follows an outage and recovery over $transport`
  - `maps an authentication failure to terminal authentication.invalid_caller, non-retryable, over $transport`
  - `carries requestId and idempotencyKey on the wire unchanged over $transport` (REST body / MCP `params._meta`)
- Tests touch only the generic client/boundary objects; no transport symbol above the seam.

### 4.5 Cross-stack leg against the REAL traderton route (n36)
- `docker/traderton-xstack.override.yml`: `services.boundary.environment.BOUNDARY_MCP_ENABLED: "true"` + comment "herobids cross-stack transport-parity leg; dev/test only (D19)".
- NEW `apps/worker/src/__tests__/xstack/transport-parity.xstack.test.ts`, `describe.skipIf(process.env['HEROBIDS_XSTACK_TRANSPORT_PARITY'] !== '1')`. Config from the worker's real `loadConfig()` + `resolveConfiguredExternalBackend` (secret from the herobids `.env`); asserts `baseUrl === 'http://localhost:8080'` before any call; per leg overrides `endpoint.protocol` (+ `mcpPath: '/internal/v1/mcp'`). Subject: `{ ownerId: 'xstack-parity-<uuid>', actor: { type: 'system', id: 'xstack-transport-parity' } }`. MCP legs run only if `GET /internal/v1/mcp` → 405; on 404 they skip with a loud warning naming "rebuild/checkout traderton phase3-mcp-surface" (REST legs always run).
  - `a read tool returns the same success outcome over rest and mcp` (`get_operator_defaults`)
  - `a same-key write replays the first terminal result over $transport` (`remove_watch`, fresh uuid)
  - `a reused key with a changed payload is rejected as validation.invalid_payload over $transport`
  - `a key first used over rest replays over mcp without a second execution`
  - If either tool needs seeded state at implementation time, pick another state-free tool and record which.
- `scripts/shell/tests/run-all-tests.sh` step 5, right after `ensure_boundary_up`: `run_tier "Cross-stack transport parity (rest + mcp)" bash -c "cd '${ROOT}' && HEROBIDS_XSTACK_TRANSPORT_PARITY=1 node --env-file=.env node_modules/vitest/vitest.mjs run apps/worker/src/__tests__/xstack/transport-parity.xstack.test.ts"` (env is process-scoped; G3's shell stays clean; no URL is read from env). TASKS evidence must show the MCP legs **executed** (count), not skipped.
- D19 unaffected: api/worker/agents stay `protocol: rest`; no YAML change outside comments.

### 4.6 herobids tests (behaviour-named)
`packages/domain/src/external-backend/transports/mcp-transport.test.ts` (`vi.stubGlobal('fetch', …)` serving canned initialize / 202 / 405 / tools-call replies; promoted leg B):
- `signs every POST over its exact body bytes with the MCP path` · `forwards the body string it signed unchanged` · `sets x-request-deadline-at to the envelope deadline on every frame` · `sends the envelope fields in params._meta and the payload as arguments` · `refuses to sign a request for a path other than the MCP path` · `maps success, isError failure and in_progress structuredContent to terminal, terminal and in_progress` · `treats missing or malformed structuredContent, or an isError flag that disagrees with the outcome, as an unreadable response` · `maps a JSON-RPC error carrying a failure envelope to that terminal failure` · `maps timeouts, refused connections and HTTP errors to transport_error without throwing` · `bounds connect and call together by the attempt timeout` · `closes the client after every invocation` · `rejects a non-object payload without any network request`.
`mcp-signing-fetch.test.ts`: `produces exactly the headers signRequest produces for the same bytes`; `aborts the request when the exchange signal fires`; `throws on a non-string request body`.
`mcp-wire.test.ts`: `accepts each closed-union failure code and rejects an unknown code`; `unwraps a terminal status into its result`.
`select-transport.test.ts`: `registers the mcp transport for protocol mcp and per-tool overrides`; `refuses protocol mcp without an mcpPath`.
`client.test.ts` (IV-2): `bounds each attempt by the time remaining to the deadline`; `uses requestTimeoutMs when the deadline is further away`; `sends an already-expired invocation with the full attempt budget so the backend answers deadline.expired`.
Unmodified and green: `sign.test.ts`, `signing-vectors.test.ts`, `client-signing-vectors.test.ts`, `client-await.test.ts`, T0.6 characterisation tests. If any needs more than added cases → stop and diagnose (behaviour change).

### 4.7 Web barrel / leak checks
```sh
pnpm --filter @herobids/domain run clean && pnpm build
rg -l modelcontextprotocol apps/web/dist                                   # none
rg -n "transports/|modelcontextprotocol" packages/domain/dist/index.d.ts packages/domain/dist/external-backend/index.d.ts \
  packages/domain/dist/external-backend/client.d.ts packages/domain/dist/external-backend/client-config.d.ts   # none
rg -n "modelcontextprotocol" apps packages -g '!dist' -g '!**/package.json' \
  | rg -v "external-backend/transports/|__tests__/fake-idempotent-boundary|__tests__/xstack"               # none
```

### 4.8 Commits (herobids, `phase3-external-backend`)
| # | Message | Content |
|---|---|---|
| HC1 | `docs(phase3): gate-1 result and MCP wire details in Step 10 §2.5 (Phase 3 T2.1/T2.3)` | §4.1 (after TC1's ruling) |
| HC2 | `feat(domain): McpTransport behind the internal seam (Phase 3 T2.3)` | dep, `transports/mcp-*`, selector, `attemptTimeoutMs` + IV-2, domain tests |
| HC3 | `test(worker): MCP face on the fake boundary and contract suites over rest and mcp (Phase 3 T2.3)` | devDep, fake, both contract suites |
| HC4 | `test: cross-stack transport parity against the local traderton boundary (Phase 3 T2.3)` | overlay env, xstack test, run-all-tests tier |
Each commit carries its TASKS/DECISIONS/PROGRESS update. HC2/HC3 depend only on Block 1 and may run in parallel with TC2–TC4; HC4 needs TC3.

```sh
# G3 first
pnpm install && pnpm --filter @herobids/domain run clean && pnpm build && pnpm lint
pnpm exec vitest run packages/domain/src/external-backend apps/worker/src/external-backend
pnpm exec vitest run packages/domain apps/worker apps/api
pnpm --filter @herobids/domain exec vitest run src/external-backend/sign.test.ts
pnpm --filter @herobids/domain exec vitest run -t "signing vectors"
shasum -a 256 packages/domain/src/external-backend/__fixtures__/invocation-signing-vectors.json   # == SEAM §3.1
pnpm why zod -r
# I2, I3, I3b, I5, I7 per block1 §5; §4.7 leak checks
rg -n "protocol: *mcp" config/        # none outside commented examples (D19)
# rebuild the agent image (domain deps changed), then:
scripts/shell/tests/run-all-tests.sh --e2e && scripts/shell/tests/run-extra-tests.sh --all   # vs G0; record MCP xstack legs executed
```

---

## 5. G5 on both transports — where each risk is proven

| Risk | REST | MCP |
|---|---|---|
| Same key twice → one effect | contract (a)/(c1); tt `boundary.verification` §4; xstack replay | contract (a)/(c1) on mcp; tt `boundary.mcp.verification` (one bot row); xstack replay; REST→MCP cross-transport replay (tt + xstack) |
| Same key + changed payload → `validation.invalid_payload` | contract (b); tt §5; xstack | contract (b) on mcp; tt MCP verification; route test; xstack |
| Response lost after execution → reconcilable | contract (c1)/(c2)/(c3) + status-endpoint block | contract (c1)/(c2)/(c3) on mcp (same-key re-issue only; n32 limit recorded) |
| Outage + recovery → typed fail-closed, no crash/hang | transport-parity: refused, never-answers, recovery | same + dispatcher exception → sanitized -32603 → `transport_error` (route test + parity) |
| Code + retryable verbatim | transport-parity (10 codes × flag); xstack | transport-parity on mcp; tt route + SDK tests (`isError` + closed code) |

---

## 6. Records to update
- herobids: TASKS (T2.1/T2.2/T2.3 status, cursor, SHAs in both repos incl. spike branches, sub-agents, test counts, gate-1 item evidence, xstack MCP legs executed), DECISIONS n19–n37 + IV-2, program PROGRESS (Step 11b), Step 10 §1/§2.5, ADR 016 §8 note, SEAM §5 gate results, CF-6 note (n32) and the "per-call connect, re-evaluate before staging" carried note (n29); `.github/skills/external-backend-genericization/SKILL.md` (MCP leg + overlay knob).
- traderton: §3.1 docs; `.env*` twins.

## 7. Risks / open questions (none blocks)
- **R1 Late SDK frames.** A future SDK may add frames (e.g. modern negotiation if the default flips). Pinned exact; `mcp.sdk.test.ts` asserts the frame sequence, so an upgrade fails loudly.
- **R2 Key reordering.** The SDK re-serializes results; descriptor cross-checks must use JCS equality (T0.4 rule), never byte equality.
- **R3 Per-call cost.** 4 round trips per invocation; acceptable for dev/test (D19). No metrics exist (CF-5) — do not claim numbers.
- **R4 `Server` deprecation.** Pinned exact; D17 requires `Server`. Revisit at the next SDK bump.
- **R5 xstack skew.** A herobids checkout run against traderton without the MCP route skips the MCP legs loudly; Phase-3 evidence must show them executed.
- **R6 Leaked handler messages.** Mitigated by n26 (sanitized -32603). REST's Fastify 500 still includes the message (pre-existing; park as LOW in Outstanding Issues, do not fix here).
- **R7 Traderton 008 ruling diverges** from n20–n27 → follow the ruling, amend §1 here and Step 10 §2.5 before HC2.
- **Q** None for the operator. n20 is flagged for after-the-fact review only.

## 8. Out of scope
Modern-era (2026-07-28) serving; a cached MCP connection; a non-executing MCP status tool / Tasks; tools/list cross-check (T3.2); real descriptor wiring (T4.2); any `sign.ts`/`auth.ts` change; staging contact, pushes, `run-live-boundary.sh`, `RUN_UNSTABLE_LLM_LATENCY_TESTS`.

**Handoff:** no blockers. Ready for the Implementer once Block 0, T0.6 and Block 1 are committed; start at T2.1 (§2).
