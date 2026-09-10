# L3a Implementer Prompt — the Traderton REST client + config + HMAC signer (no rewire)

**Status:** ready to hand to an implementer. On branch `consume-traderton` (herobids).
**Task:** author a **Traderton REST client** (the 005 boundary caller) + its **config block** + a
**shared HMAC signer**, unit-tested against a **stubbed boundary**. **NO rewire, NO deletion** — this
slice only ADDS the client; nothing calls it in production yet (that is L3b/L3c).
**Reads:** the L3 spec `000-l3-consumption-spec.md` (this dir); the contract
`traderton/docs/005-consumer-boundary-contract.md` (sibling repo);
the byte-parity reference `traderton/packages/boundary/src/dev/sign.ts` (the committed dev
signer) + `traderton/packages/boundary/src/auth.ts` (the verifier — the canonical string it
checks).

---

## 0. Orient first

You are in **herobids** on branch `consume-traderton` (the only branch where herobids may be edited — see
the L3 spec + Traderton CANONICAL-STATE §5). herobids `main` and all other branches are untouchable. Do NOT
touch the stray untracked `apps/worker/src/watch-summary.js`. L3a ADDS a client herobids will *later* use to
call the Traderton boundary over REST; it changes no existing trading behaviour and deletes nothing.

**Invariant:** the client injects platform-owned VALUES + calls the copied Traderton tools over HTTP; it
authors NO trading logic (no risk/planner/executor). HTTP/HMAC lives in the client. If you find yourself
writing trading behaviour, stop — the seam is mis-drawn.

## 1. What L3a delivers

1. **A shared HMAC signer** producing the EXACT 005 canonical string (§2).
2. **The Traderton REST client** — builds the 005 envelope, signs, POSTs `tools:invoke`, polls
   `GET invocations/:requestId`, maps `TradertonToolResultV1` → a typed result (§3).
3. **A `boundary` config block** in `config/*.yaml` + `packages/domain/src/config/schema.ts` (§4).
4. **Unit tests** against a stubbed boundary (no network, no real Traderton) (§5).

Nothing else. No tool/broker/handler/route edits, no `ToolContext` change, no deletions.

## 2. The HMAC signer (byte-parity with the Traderton verifier)

005 §Authentication signs this exact canonical string:
```
METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(rawBody)
```
Signature header: `X-Traderton-Signature: sha256=<hex HMAC-SHA256(secret, canonicalString)>`. Required
headers: `Content-Type: application/json`, `X-Traderton-Consumer-Id`, `X-Traderton-Key-Id`,
`X-Traderton-Timestamp` (RFC3339 UTC), `X-Traderton-Signature`, `X-Request-Deadline-At` (= `body.deadlineAt`).

- **MIRROR the Traderton dev signer** `traderton/packages/boundary/src/dev/sign.ts` (READ it) so
  the signed bytes match the verifier exactly. Key parity points from that signer + `auth.ts`:
  - the PATH is the path only, **no query string**;
  - the SHA256 hashes the **raw body bytes** that are ALSO the wire payload (serialize once, sign + send the
    same bytes — do not re-serialize);
  - the signature is lowercase hex, prefixed `sha256=`;
  - `X-Request-Deadline-At` MUST equal the body's `deadlineAt` (the boundary asserts header↔body match).
- Follow herobids' existing HMAC style (`apps/api/src/routes/connections-oauth-state.ts` ~:16/:47–52 uses
  `crypto.createHmac('sha256', secret)`; `auth.ts` uses `timingSafeEqual`). There is **no shared signing
  util** in herobids yet — factor a small one (e.g. `apps/worker/src/traderton/sign.ts`) rather than
  inlining. NOTE: herobids' existing helpers use `base64url` digests; the 005 signature is **hex** — match
  005/the Traderton verifier (hex), not the herobids OAuth convention.

## 3. The Traderton REST client

Author `apps/worker/src/traderton/client.ts` (a small `fetch`-based client — herobids has no shared HTTP
client class; `fetch` + a per-use helper is the norm). It must:

- **Build the 005 envelope** `TradertonToolInvocationV1` (shape from 005 §Invocation Contract):
  `{ contractVersion: '1.0', requestId, idempotencyKey, correlationId, issuedAt, deadlineAt,
  caller: { consumerId, keyId }, subject: { ownerId, actor: { type, id } }, toolName, payload }`. The client
  takes the tool name + payload + the injected subject/caller VALUES + a deadline; it generates
  requestId/idempotencyKey/correlationId/issuedAt (or accepts them for retry/idempotency reuse).
- **Sign + POST** `${baseUrl}/internal/v1/tools:invoke` with the signed headers (§2). Serialize the envelope
  once; sign + send those exact bytes.
- **Map the response** `TradertonToolResultV1` (`{ contractVersion, requestId, correlationId, outcome:
  { kind:'success', payload } | { kind:'failure', code, message, retryable, details? } }`) OR the
  in-progress status shape `TradertonToolInvocationStatusV1` into a typed client result the caller can
  branch on (success payload | typed failure | in_progress). Preserve the failure `code` + `retryable`
  (do not collapse them — L3b/L3c callers map them to the tool replies).
- **Poll for the async/ambiguous case (D3):** if the invoke returns in-progress (idempotency-key reuse while
  running) or the caller needs to resolve an ambiguous timeout, poll
  `GET ${baseUrl}/internal/v1/invocations/:requestId` (signed the same way, empty body) until terminal or
  the deadline passes. Expose this as a method the L3c `submit_decision` rewire will use to reproduce the
  synchronous 30s-BLPOP feel. (Do NOT wire it to `submit_decision` here — L3c does that.)
- **Timeouts + errors:** honour a request timeout from config; a transport failure (no terminal response)
  is surfaced as a distinct retryable client error (the caller decides whether to poll/retry within the
  deadline, per 005 §Deadlines/Retries). Never throw a raw error that leaks the boundary internals.
- **SSRF/allowlist:** the base URL is operator config (trusted), but reuse herobids' `ssrf-guard.ts` posture
  if the existing outbound-client convention applies.

## 4. Config

Add a `boundary` block to `config/default.yaml` (+ the env-specific overlays as needed) and validate it in
`packages/domain/src/config/schema.ts` (Zod; mirror the existing `baseUrl: z.string().url()` at ~line 52 and
the secret-ref/env-override convention, e.g. `STRIPE_WEBHOOK_SECRET`). Shape:
```yaml
boundary:                       # the Traderton REST boundary herobids consumes
  baseUrl: https://traderton.internal   # override: TRADERTON_BOUNDARY_URL (local dev: the compose boundary)
  consumerId: herobids
  keyId: current
  hmacSecretRef: ${TRADERTON_BOUNDARY_HMAC_SECRET}   # local signing material; never crosses the boundary
  requestTimeoutMs: 10000
  idempotencyRetentionHours: 168        # informational (mirrors the boundary's retention)
```
The secret is resolved from env (never committed). `baseUrl` for local dev points at Traderton's
`docker-compose.yml` boundary (`http://localhost:8080`).

## 5. Tests (unit, against a STUBBED boundary — no network, no real Traderton)

- **Signer parity:** given a fixed method/path/timestamp/body + secret, the signer produces the expected
  canonical string + `sha256=<hex>` signature. Cross-check the canonical-string construction against the
  Traderton dev signer's rules (path has no query; raw-bytes hash; hex). If feasible, assert the signature
  matches what Traderton's `buildCanonicalString` + HMAC would produce for the same inputs (copy the
  expected value from a Traderton unit-test vector, or compute it — the point is byte-parity).
- **Envelope build:** the client emits a well-formed `TradertonToolInvocationV1` (all required fields;
  `X-Request-Deadline-At` header equals `body.deadlineAt`; caller matches the headers).
- **Response mapping:** stub `fetch` to return (a) a success envelope → client returns success payload;
  (b) a typed failure (e.g. `validation.invalid_payload`, retryable=false) → client returns that code +
  retryable; (c) an in-progress status → client surfaces in_progress; (d) a transport failure → the
  retryable client error.
- **Poll:** stub the status endpoint to return in_progress then terminal → the poll resolves to terminal;
  a deadline pass → a deadline/timeout client error.
- Do NOT stand up a real boundary here (that is L3e's differential + Traderton's own compose). Unit-level,
  fakes only.

## 6. Guardrails / done criteria

- **No rewire, no delete** — L3a only ADDS the client + config + tests. No existing trading path changes.
- **Author no trading behaviour** — the client is transport + envelope + mapping only.
- **Signer must byte-match the Traderton verifier** — mirror `dev/sign.ts`; hex (not base64url).
- **Do NOT touch `main` / other branches / `watch-summary.js`.**
- herobids build + lint + the herobids test suite stay green; the new unit tests pass.
- Report: files added, how the signer achieves byte-parity, the client's method surface (invoke + poll +
  the typed result), the config block, and any seam surfaced. Do NOT commit — the coordinator commits on the
  branch.
- **Then PAUSE** — L3b (rewire the read tools to the client) is the next slice, gated on human review of L3a.
