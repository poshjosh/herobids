# Phase 3 Block 0 — fixture tasks T0.3, T0.4, T0.5 (plan)

**Status:** plan only, not implemented. **Written:** during G0 baseline run (repos untouched).
**Normative inputs:** `herobids/docs/features/2026/10/02/005-phase3-program/{ENTRYPOINT,TASKS,SEAM,INVARIANTS}.md`,
Step 10 plan `herobids/docs/features/2026/09/24/006-step10-external-backend-contract-and-trust-plan.md` (§3, §5, §7 Step 0).
**Repos/branches:** `hb` = `~/dev_ai/herobids` (`phase3-external-backend`), `tt` = `~/dev_ai/traderton` (`phase3-mcp-surface`).

## 0. Ordering, commits, ground facts

- **T0.3 must land before T1.1** (vectors pinned against pre-rename code). T0.3/T0.4/T0.5 are otherwise independent;
  run them sequentially on the branch because T0.3 and T0.4 both edit `SEAM.md` + `TASKS.md`.
- **Commits (one per task per repo, branch only, never push):**
  | Task | hb commit | tt commit |
  |---|---|---|
  | T0.3 | `test(domain): shared invocation signing vectors (Phase 3 T0.3)` | `test(boundary): shared invocation signing vectors (Phase 3 T0.3)` |
  | T0.4 | `test(domain): descriptor conformance fixtures (Phase 3 T0.4)` | `test(boundary): descriptor conformance fixtures (Phase 3 T0.4)` |
  | T0.5 | `feat(worker): injectable external-skill installer + local fixture source (Phase 3 T0.5)` | — (none) |
  Each hb commit also carries that task's `TASKS.md` status/cursor/running-notes update (and `SEAM.md`/`DECISIONS.md`/Step 10 edits named below).
- **Ground facts verified while planning:**
  - hb signer `packages/domain/src/traderton/sign.ts`: `buildCanonicalString`, `signRequest`, `signInvoke` (serializes with `JSON.stringify(envelope)`), `signStatus`. Header set (lower-case): `content-type`, `x-traderton-consumer-id`, `x-traderton-key-id`, `x-traderton-timestamp`, `x-traderton-signature`, `x-request-deadline-at`. These symbols are **not** in the Step 10 §2 rename table, so a test importing only `./sign.js` survives T1.1 unmodified.
  - hb `TradertonClient.buildEnvelope` key order: `contractVersion, requestId, idempotencyKey, correlationId, issuedAt, deadlineAt, caller, subject, toolName, payload`.
  - tt verifier `packages/boundary/src/auth.ts` exports its own `buildCanonicalString` + `authenticateRequest(request, config, now, bodyAssertions?)`; `app.ts` `toSignedRequest` strips `?…` from `request.url`; status route `GET /internal/v1/invocations/:requestId`; `createBoundaryApp(deps)` deps = `config, registry, contextFactory, invocationStore, computeRequestFingerprint, retentionMs, now` (pattern in `app.test.ts:28-163`). Read-only tool categories bypass the store.
  - Both repos: `tsconfig` excludes `src/**/*.test.ts`; root `vitest.config.ts`; `tsx` available in hb `@herobids/scripts` (`scripts/ts/*.ts`, no tsconfig → not type-checked). No `.gitattributes` in either repo.
  - **`pnpm lint` (`tsc --noEmit` on a root tsconfig with `files: []` + references) appears to check no inputs** (G0 log shows no output). Not confirmed by experiment. Treat `pnpm build` (`tsc --build`) as the real type-check for non-test source, and run I7's grep for escape hatches on test files (tests are excluded from every tsconfig).

---

## T0.3 — Shared invocation signing vectors (pre-rename)

### Fixture

Paths (byte-identical copies):
- hb `packages/domain/src/traderton/__fixtures__/invocation-signing-vectors.json` — **moves with the dir to `packages/domain/src/external-backend/__fixtures__/` at T1.1** (the path SEAM.md §3.1 already names). All test references are `import.meta.url`-relative, so the move needs no test edit.
- tt `packages/boundary/src/__fixtures__/invocation-signing-vectors.json`.

Shape (written by the generator as `JSON.stringify(file, null, 2) + "\n"`; non-ASCII stored as literal UTF-8):
```jsonc
{
  "formatVersion": 1,
  "description": "Shared 005 HMAC invocation signing vectors. Byte-identical in herobids and traderton. DO NOT EDIT BY HAND: regenerate with herobids scripts/ts/generate-signing-vectors.ts, copy to traderton, update the sha256 constant in both tests and SEAM.md §3.1.",
  "generator": "herobids scripts/ts/generate-signing-vectors.ts",
  "secretIsTestOnly": true,
  "cases": [
    {
      "id": "invoke-full-envelope",            // also: status-empty-body, status-query-stripped, invoke-non-ascii-body
      "description": "...",
      "method": "POST",
      "requestPath": "/internal/v1/tools:invoke",   // path as sent on the wire (may carry a query)
      "signedPath":  "/internal/v1/tools:invoke",   // path inside the canonical string
      "timestamp":  "2026-10-02T12:00:00.000Z",
      "deadlineAt": "2026-10-02T12:00:30.000Z",
      "consumerId": "herobids",
      "keyId": "signing-vector-key",
      "secret": "phase3-signing-vector-test-secret",
      "body": "{\"contractVersion\":\"1.0\",...}",   // exact string; "" for GET
      "bodyUtf8ByteLength": 0,
      "bodyUtf16Length": 0,
      "bodySha256": "<hex>",
      "expectedCanonical": "POST\n/internal/v1/tools:invoke\n2026-10-02T12:00:00.000Z\n<hex>",
      "expectedSignature": "sha256=<hex>",
      "expectedHeaders": { "content-type": "application/json", "x-traderton-consumer-id": "herobids", "...": "all 6" }
    }
  ]
}
```
No commit SHA or source path inside the file (either would change the bytes on regeneration/rename and break the "regenerates byte-identically" check).

Cases (all share consumerId/keyId/secret/timestamp/deadlineAt above):
1. `invoke-full-envelope` — POST `/internal/v1/tools:invoke`. Body = `JSON.stringify(client.buildEnvelope({...all ids supplied}))`: requestId `req-vector-1`, idempotencyKey `idem-vector-1`, correlationId `corr-vector-1`, issuedAt = timestamp, subject `{ownerId:"owner-vector-1", actor:{type:"agent", id:"agent-vector-1"}}`, toolName `echo_vector`, payload `{"value":"hello"}`. (Generic tool name so tt can register a matching echo tool and get `success` through the real app.)
2. `status-empty-body` — GET `tradertonStatusPath("req-vector-2")`, body `""`.
3. `status-query-stripped` — GET; `signedPath` = `/internal/v1/invocations/req-vector-3`, `requestPath` = `signedPath + "?wait=true&trace=1"`. Signed over `signedPath`.
4. `invoke-non-ascii-body` — as case 1 with ids `*-vector-4` and payload `{"value":"naïve café – 日本語 – 🚀"}` (2-, 3- and 4-byte UTF-8 sequences; `bodyUtf8ByteLength !== bodyUtf16Length`).

### Generator (commit it)

hb `scripts/ts/generate-signing-vectors.ts` + `"generate-signing-vectors": "tsx ts/generate-signing-vectors.ts"` in `scripts/package.json`.
- Header comment: purpose, "test-only secret", regeneration procedure, and "never regenerate to make a failing vector pass — a diff means the signer bytes changed (Step 10 §5)".
- Imports **source**, not dist: `../../packages/domain/src/traderton/index.js` (tsx maps `.js`→`.ts`). T1.1 must repoint this import (`rg -n "domain/src/traderton" scripts/` finds it).
- Builds cases with `new TradertonClient({...}).buildEnvelope(...)`, `signInvoke(identity, TRADERTON_INVOKE_PATH, envelope, { timestamp })`, `signStatus(identity, tradertonStatusPath(id), { timestamp, deadlineAt })`, `buildCanonicalString(...)`.
- Modes: default writes the hb fixture; `--check` regenerates in memory and exits 1 if bytes differ from the committed file (useful extra rename proof after T1.1). Prints the file sha256.
- tt gets a plain byte copy (`cp`); no generator in tt.

Digest: `sha256(fileBytes)` lowercase hex. Shell cross-check: `shasum -a 256 <path>` in both repos must print the same value.

### hb tests

**A. `packages/domain/src/traderton/signing-vectors.test.ts`** — imports only `./sign.js` (must pass byte-unmodified through T1.1).
`describe('invocation signing vectors (shared with traderton)')`:
- `it('fixture file digest equals the recorded constant')` — `SIGNING_VECTORS_SHA256` const == sha256(readFileSync(new URL('./__fixtures__/invocation-signing-vectors.json', import.meta.url))).
- `it('contains exactly the four required cases')` — id set equality (stops a case being silently dropped).
- `it.each(cases)('buildCanonicalString reproduces the canonical string for $id')`.
- `it.each(cases)('signRequest emits the recorded signature and headers for $id')` — `toEqual(expectedHeaders)`.
- `it.each(postCases)('signInvoke serializes $id to the recorded body and headers')` — envelope = `JSON.parse(body)` narrowed with a **type-guard function** (`hasDeadlineAt(v): v is { deadlineAt: string }`), **not** Zod: Zod object parsing rebuilds objects and can reorder keys. Assert `rawBody === body`, headers equal.
- `it.each(getCases)('signStatus emits the recorded headers for $id')`.
- `it('query case: signedPath is requestPath without its query, and signing the query path does not match')`.
- `it('non-ASCII case: hash is over UTF-8 bytes, whose length differs from the UTF-16 length')` — recorded lengths + `bodySha256`.
- Fixture parsed with a Zod schema (`SigningVectorFileSchema`) — fine here: only the `body` string matters for bytes.

**B. `packages/domain/src/traderton/client-signing-vectors.test.ts`** — client wire bytes (guards T0.6/T1.2 envelope changes). Imports `./client.js` (T1.1 renames the symbol imports here mechanically; assertions unchanged).
`describe('client wire bytes match the invocation signing vectors')`:
- `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(new Date(c.timestamp))`; `vi.stubGlobal('fetch', vi.fn<typeof fetch>())` returning `new Response(JSON.stringify(terminalResult), { status: 200, headers: { 'content-type': 'application/json' } })` (no `as unknown as Response`).
- POST cases: `client.invoke({...ids from JSON.parse(body)})` → captured `init.body === c.body`, `init.headers` `toEqual(c.expectedHeaders)`, url = baseUrl + `requestPath`.
- `status-empty-body`: `client.poll('req-vector-2', { deadlineAt })` → url = baseUrl + `signedPath`, headers equal.
- `status-query-stripped`: `tradertonStatusPath('req-vector-3') === signedPath` (the client never emits a query).

**C. `packages/domain/src/traderton/sign.test.ts` — comment-only edit, logic untouched.** Replace the header block (lines 11-19) with:
```ts
/**
 * Signer self-consistency against an inline replica of the verifier algorithm.
 *
 * NOT a cross-repo guard. `verifierCanonical` / `verifierSignature` below are a
 * hand-copied snapshot of traderton/packages/boundary/src/auth.ts: if that file
 * changes, these tests still pass, so they cannot detect signer/verifier drift.
 * The cross-repo guard is the shared fixture
 * `./__fixtures__/invocation-signing-vectors.json`, asserted here by
 * `./signing-vectors.test.ts` and in traderton by
 * packages/boundary/src/signing-vectors.test.ts against the real
 * `authenticateRequest` (Phase 3 SEAM.md §2, §3.1). Test logic is intentionally
 * unchanged: this file must pass unmodified after the T1.1 rename (Step 10 §5).
 */
```
and the two one-line docs at lines 27/33 to `/** Inline snapshot of the verifier's canonical string (auth.ts) — not a drift guard; see header. */` / `... expected signature ...`. All references are relative or tt-repo paths, so the text stays true after T1.1.

### tt test — `packages/boundary/src/signing-vectors.test.ts`

`describe('invocation signing vectors (shared with herobids)')` (unit, against `authenticateRequest`):
- `it('fixture file digest equals the recorded constant')` — same `SIGNING_VECTORS_SHA256` value.
- `it.each(cases)('auth buildCanonicalString reproduces the canonical string for $id')`.
- `it.each(cases)('authenticateRequest accepts $id')` — config `{ clockSkewMs: 30_000, idempotencyRetentionHours: 168, allowedConsumers: { [consumerId]: { keyId, secret } } }`, `now = Date.parse(timestamp)`, `path = signedPath`, headers mapped from `expectedHeaders`, `bodyAssertions` from the parsed body for POST cases. Returns `{ consumerId, keyId }`.
- `it.each(cases)('rejects a one-byte body mutation for $id')` — non-empty: copy and `buf[buf.length - 1] ^= 0x01`; empty: append one byte. Expect `BoundaryFailure` with `code === 'authentication.invalid_caller'`.
- `it.each(cases)('rejects a one-byte signature mutation for $id')` — swap the last hex char.
- `it('query case: verifying over requestPath (unstripped) is rejected')` — proves stripping is load-bearing.

`describe('invocation signing vectors through the real boundary app')` — **feasible, so use it** (no fallback needed): local copies of the minimal deps (echo tool `echo_vector`, category `read-config`, `parametersSchema: z.object({ value: z.string() })`; context factory as in `app.test.ts`; fake store whose `findByRequestId` returns an `in_progress` row for the case's requestId; trivial fingerprint; `now: () => Date.parse(c.timestamp)`). Do **not** import from or modify `app.test.ts` (gate 2 requires it unmodified).
- `it.each(postCases)('POST $id with the recorded headers and body succeeds')` — `app.inject({ method:'POST', url: c.requestPath, headers: c.expectedHeaders, payload: c.body })` → `outcome.kind === 'success'`, `payload.echoed === <payload.value>` (proves raw-body retention hashes UTF-8 bytes for case 4).
- `it.each(getCases)('GET $id is authenticated by the real app')` — `url: c.requestPath` (case 3 carries the query) → in-progress status shape, not `authentication.invalid_caller`. This is the strip proof through `toSignedRequest`.

### Steps

1. hb: write generator → run `pnpm --filter @herobids/scripts run generate-signing-vectors` → record printed sha256.
2. hb: write tests A, B; put the digest in `SIGNING_VECTORS_SHA256`; annotate `sign.test.ts` (C).
3. hb: `generate-signing-vectors -- --check` exits 0 (determinism).
4. tt: `mkdir -p packages/boundary/src/__fixtures__ && cp <hb fixture> <tt fixture>`; `shasum -a 256` both → equal.
5. tt: write `signing-vectors.test.ts` with the same constant.
6. hb: `SEAM.md §3.1` → `invocation-signing-vectors.json  sha256 = <hex>`; add a parenthetical under the table: "pre-T1.1 the herobids copy lives at `packages/domain/src/traderton/__fixtures__/`; it moves with the dir". `TASKS.md`: T0.3 ✅, cursor, running notes (both SHAs, test counts, digest).
7. Commit both repos.

### Verify

```sh
# hb
pnpm exec vitest run packages/domain/src/traderton/signing-vectors.test.ts packages/domain/src/traderton/client-signing-vectors.test.ts packages/domain/src/traderton/sign.test.ts packages/domain/src/traderton/client.test.ts
pnpm --filter @herobids/domain exec vitest run -t "signing vectors"     # INVARIANTS I4 form (if package-local collection fails for unrelated files, record it and use the root form)
pnpm --filter @herobids/scripts run generate-signing-vectors -- --check
pnpm lint
# tt
pnpm exec vitest run packages/boundary/src/signing-vectors.test.ts packages/boundary/src/app.test.ts
pnpm exec vitest run packages/boundary -t "signing vectors"
pnpm lint
# both
shasum -a 256 <hb fixture> <tt fixture>    # identical, equals SEAM.md §3.1
git diff --cached -- '*.ts' | rg -n "^\+.*(\bas unknown as\b|@ts-ignore|@ts-expect-error|: *any\b)"   # I7: zero
```

---

## T0.4 — Descriptor conformance fixtures

### Decision to record first (P3-n, next free number) + Step 10 §3 clarification

SEAM §4 rule: amend the Step 10 plan before the fixtures. Add to §3, after the `// Transport:` line, a "Canonicalization and encoding (clarified, P3-n)" paragraph:
- **Canonical JSON = RFC 8785 (JCS)**: object keys sorted recursively by UTF-16 code units (JS default `sort()`), no insignificant whitespace, arrays in order, primitives serialized exactly as ECMAScript `JSON.stringify`, encoded UTF-8. Value domain: objects, arrays, strings, booleans, null, integers within ±(2^53−1); no non-integer numbers in descriptors. For this domain a recursive sorted-key `JSON.stringify` **is** JCS.
- **Transport wrapper** `{ descriptor: <object>, signature, keyId }`. `signature` = base64 (RFC 4648 §4, padded) of the 64-byte ed25519 signature over `UTF-8(JCS(descriptor))`. Wrapper formatting/key order is not signed and irrelevant. (Rejected: carrying the descriptor as a pre-canonicalized string — robust, but diverges from the Step 10 text and is worse to review/diff in traderton-skills; the verifier must canonicalize for the pin digest anyway.)
- **`keyId` selects exactly one** `trustedDescriptorSigningKeys[]` entry (`active` or `retiring`); no try-every-key fallback.
- **`publicKey` = PEM SPKI** (`-----BEGIN PUBLIC KEY-----`), resolving §1's "PEM/base64".
- **Pin digest** (`descriptorPinning.sha256`) = lowercase hex sha256 of `UTF-8(JCS(descriptor))`.
- **`tools/list` cross-check (D16, proposed; normative when T2.2/T3.2 implement):** agree ⇔ same tool-name set as the union of the descriptor's `sourceSkills[].tools`, and per tool `description` string-equal and `inputSchema` JCS-equal (`category` is not compared; MCP `tools/list` has no such field). Any disagreement → instruction-only.
Decision rationale (one sentence, so no Contemplator per ENTRYPOINT §5.1): JCS is the standard deterministic JSON form and coincides with `JSON.stringify` primitives, so both repos implement it in a few lines with no dependency. Record in `DECISIONS.md §3` with before ("canonical JSON", undefined) / after.

### Fixture choice: generic only

A fictional `example-echo` backend (refs `example/skills/echo`, `example/skills/reverse`; tools `echo_text`, `reverse_text`; category `read-config`). No real trading tool shape: (1) herobids must not carry trading content and the conformance suite passing on a non-trading backend is direct evidence for I12; (2) a copied trading schema would be an unsynchronised second copy of Traderton's tool schemas, which D16 forbids in spirit; (3) the real (dev-signed) trading descriptor is verified end-to-end at T4.2/T4.3. The same `example/skills/echo` ref is the T0.5 fixture skill, so T3.x/T4.3 can run install → descriptor → tools on the example backend too.

### Files (byte-identical in both repos)

hb `packages/domain/src/traderton/__fixtures__/descriptor-conformance/` (moves to `external-backend/` at T1.1); tt `packages/boundary/src/__fixtures__/descriptor-conformance/`:

| File | Content |
|---|---|
| `manifest.json` | rules, key, base definition, variants (below) |
| `valid.json` | wrapper; descriptor `backendId: "example-echo"`, `issuedAt 2026-10-01T00:00:00.000Z`, `expiresAt 2099-01-01T00:00:00.000Z` (no time bomb), two sourceSkills; one instruction string contains non-ASCII (`—`, `✓`) to pin UTF-8; generator inserts keys in non-sorted order so canonicalization must reorder |
| `bad-signature.json` | `valid` with signature byte 0 XOR 0x01 |
| `wrong-backend-id.json` | `backendId: "example-other"`, validly signed |
| `expired.json` | `expiresAt 2026-09-30T00:00:00.000Z` (< evaluationTime), validly signed |
| `unapproved-ref.json` | sourceSkill ref `example/skills/unapproved` (not approved), validly signed |
| `unknown-key-id.json` | `valid` descriptor + signature, wrapper `keyId: "example-echo-unknown-key"` |
| `tools-list-agrees.tools-list.json` | MCP `ListToolsResult` `{ tools: [{name, description, inputSchema}] }` exactly matching the descriptor |
| `tools-list-disagrees.tools-list.json` | same, `echo_text.description` altered (tool-poisoning style) |

`manifest.json`:
```jsonc
{
  "formatVersion": 1,
  "description": "Descriptor conformance fixtures (Step 10 §3, DT3/DT4). TEST-ONLY, dev-signed by an ephemeral key that was discarded. Regenerate with herobids scripts/ts/generate-descriptor-conformance-fixtures.ts; copy to traderton; update the dir digest in both tests and SEAM.md §3.2.",
  "canonicalization": "RFC 8785 JCS, UTF-8",
  "signature": "ed25519 over UTF-8(JCS(descriptor)), base64 padded",
  "pinDigest": "sha256 hex over UTF-8(JCS(descriptor))",
  "evaluationTime": "2026-10-02T12:00:00.000Z",
  "signingKey": { "keyId": "example-echo-dev-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" },
  "baseDefinition": {                       // trust-relevant projection of ExternalBackendDefinition (§1); T3.1 adds dummy endpoint/caller/health
    "backendId": "example-echo",
    "enabled": true,
    "trustedDescriptorSigningKeys": [{ "keyId": "example-echo-dev-1", "publicKey": "<same PEM>", "status": "active" }],
    "approvedSourceSkillRefs": ["example/skills/echo", "example/skills/reverse"],
    "descriptorPinning": { "mode": "maxAge", "seconds": 3600 }   // maxAge so negatives isolate ONE defect
  },
  "variants": [
    { "id": "valid", "descriptorFile": "valid.json", "installedSkillRef": "example/skills/echo",
      "definitionOverrides": {}, "canonicalSha256": "<hex>",
      "expected": { "outcome": "tools_exposed", "toolNames": ["echo_text"] } }
    // ... one entry per row below; definitionOverrides = shallow replace of top-level baseDefinition keys
  ]
}
```

| Variant id | descriptorFile / extra | definitionOverrides | expected (`reason` = proposed code, advisory) |
|---|---|---|---|
| `valid` | `valid.json` | — | `tools_exposed` `["echo_text"]` (not `reverse_text`: per-ref scoping) |
| `valid-pinned` *(positive control)* | `valid.json` | pinned, sha256 = valid's canonicalSha256 | `tools_exposed` |
| `retiring-key-accepted` *(positive control)* | `valid.json` | key `status: "retiring"` | `tools_exposed` |
| `bad-signature` | `bad-signature.json` | — | `instruction_only` `descriptor.signature_invalid` |
| `wrong-backend-id` | `wrong-backend-id.json` | — | `instruction_only` `descriptor.backend_mismatch` |
| `expired` | `expired.json` | — | `instruction_only` `descriptor.expired` |
| `unapproved-ref` | `unapproved-ref.json`, installed ref `example/skills/unapproved` | — | `instruction_only` `descriptor.ref_not_approved` |
| `unknown-key-id` | `unknown-key-id.json` | — | `instruction_only` `descriptor.unknown_key` |
| `pin-mismatch` | `valid.json` | pinned, sha256 = wrong-backend-id's canonicalSha256 | `instruction_only` `descriptor.pin_mismatch` |
| `tools-list-agrees` *(positive control)* | `valid.json` + `tools-list-agrees.tools-list.json` | — | `tools_exposed` |
| `tools-list-disagrees` (D16) | `valid.json` + `tools-list-disagrees.tools-list.json` | — | `instruction_only` `descriptor.tools_list_mismatch` |
| `definition-disabled` (§4 revocation) | `valid.json` | `enabled: false` | `instruction_only` `definition.disabled` |

Positive controls exist so a pipeline that always fails pinned mode / retiring keys / cross-check cannot pass the matching negatives trivially. `outcome` is normative; T3.1 adopts the `reason` codes or records the divergence in `DECISIONS.md`.

### Generator (commit it; key never on disk)

hb `scripts/ts/generate-descriptor-conformance-fixtures.ts` + `"generate-descriptor-fixtures"` script entry.
- `generateKeyPairSync('ed25519')`; export only the public key (`spki`/`pem`); the private key lives in memory and is discarded at exit (header comment says so; prints "private key discarded").
- Local `canonicalizeJcs(value)` (recursive sorted-key stringify; throws on non-integer numbers/non-JSON values); `sign(null, Buffer.from(jcs, 'utf8'), privateKey).toString('base64')`.
- Writes the 9 files (`JSON.stringify(x, null, 2) + "\n"`), fills each variant's `canonicalSha256`, prints the dir digest.
- Non-deterministic by design (fresh key each run): regenerating changes every signature + the digest, so it is a deliberate act that updates both repos and SEAM.md together.

### Dir digest (precise)

Files = entries directly in the dir whose name matches `^[a-z0-9.-]+\.json$` (no subdirs; dotfiles such as `.DS_Store` excluded); sort names with JS default sort (= byte order for ASCII); sha256 over the concatenation of `name + "\n" + <file bytes> + "\n"` per file; lowercase hex.
Shell equivalent (record alongside the value in SEAM.md §3.2):
```sh
cd <dir> && for f in $(ls | grep -E '^[a-z0-9.-]+\.json$' | LC_ALL=C sort); do printf '%s\n' "$f"; cat "$f"; printf '\n'; done | shasum -a 256
```

### hb test — `packages/domain/src/traderton/descriptor-conformance.test.ts`

Always on — `describe('descriptor conformance fixtures are well-formed')`:
- `it('fixture dir digest equals the recorded constant')` — `DESCRIPTOR_CONFORMANCE_DIR_SHA256`.
- `it('the dir holds exactly the expected files and every manifest reference resolves')`.
- `it.each(descriptorFiles)('JCS bytes of $file hash to the manifest canonicalSha256')` — test-local `canonicalizeJcs`; the manifest hashes are the data that T3.1's real canonicalizer must also reproduce.
- `it('valid descriptor verifies with ed25519 against the manifest public key')` — `verify(null, bytes, createPublicKey(pem), Buffer.from(sig, 'base64'))`.
- `it('each tampered variant carries exactly its declared defect')` — `bad-signature` fails verify; `unknown-key-id`, `wrong-backend-id`, `expired`, `unapproved-ref` all verify under the real key (their only defect is the declared one); `tools-list-agrees` matches the descriptor under the cross-check rule, `tools-list-disagrees` does not.

Pending until T3.1 — `describe.skip('descriptor conformance pipeline — TODO(T3.1) flip to describe')`:
- Assertions written now: `it.each(manifest.variants)('$id → $expected.outcome', ...)` calling a local placeholder
  `const resolveDescriptorTools: ResolveDescriptorTools = () => { throw new Error('TODO(T3.1): import the real pipeline'); };`
  where `ResolveDescriptorTools` is a local type `(input: { definition, wrapper, installedSkillRef, now, toolsList? }) => { outcome: 'tools_exposed'; tools: Array<{ name: string }> } | { outcome: 'instruction_only'; reason: string }`.
- T3.1 flip = replace the placeholder with the real import (adapting the input mapping if T3.1's signature differs) and `describe.skip` → `describe`. Rationale for `describe.skip` over `it.todo`: the assertion bodies exist now and show in the skipped count; nothing imports a module that does not exist yet, so collection stays green.

### tt test — `packages/boundary/src/descriptor-conformance.test.ts`

`describe('descriptor conformance fixtures are well-formed')` — same digest constant, file-set check, JCS→`canonicalSha256`, ed25519 verify of `valid`, tamper self-consistency (tt will serve `tools/list` verbatim from a signed descriptor at T2.2, so it must agree on the canonical bytes).

### Steps

1. hb: amend Step 10 §3 (paragraph above); append P3-n to `DECISIONS.md §3`.
2. hb: write generator; run `pnpm --filter @herobids/scripts run generate-descriptor-fixtures`; record the dir digest.
3. hb: write the test; fill `DESCRIPTOR_CONFORMANCE_DIR_SHA256`.
4. tt: `cp -R` the dir; run the shell digest in both repos → equal.
5. tt: write the test.
6. hb: `SEAM.md §3.2` digest line + the digest rule/shell command + variant-table note on the 4 added rows (positive controls + disabled); `TASKS.md` T0.4 ✅ + notes.
7. Commit both repos.

### Verify

```sh
# hb
pnpm exec vitest run packages/domain/src/traderton/descriptor-conformance.test.ts   # well-formed tests pass; pipeline block reported as skipped
pnpm lint
# tt
pnpm exec vitest run packages/boundary/src/descriptor-conformance.test.ts
pnpm lint
# both: no private key anywhere
rg -l "PRIVATE KEY" packages/ scripts/ ; git status --porcelain     # no key files, only the intended additions
```

---

## T0.5 — Local fixture external-skill source

### How install works today (investigated)

- `add_skills` (`apps/worker/src/tools/skills.ts`) splits refs into platform (DB slug/id) vs external (contains `/`, not `system/`). External refs install **sequentially** via `runExternalSkillInstall` → `normalizeExternalRef` (`owner/repo/skill` → `owner/repo@skill`) → `spawn('npx', ['skills','add',<ref>,'--yes'], { cwd: workspaceRoot, env: {...process.env, CI:'1'}, timeout: 30s })`. Workspace root = `getWorkspacePaths(agentId).root` (`AGENT_WORKSPACE_ROOT` env or `/tmp/herobids-agent-workspaces/<agentId>`).
- The CLI writes `<root>/.agents/skills/<sanitizeName(frontmatter.name)>/`; it requires `name` + `description` frontmatter (read from skills@1.5.25 in the local npx cache). Post-install, `detectExternalSkillBashDependency` reads `<root>/.agents/skills/<deriveSkillDirName(ref)>/SKILL.md` to auto-add `system/programming`. `list_skills`/`remove_skills` also spawn the CLI.
- `ExternalSkillProvider` (domain port; `ExternalSkillProviderHttp`; used by `search_skills` and api `GET /skills` via `mapExternalToSkillView`) is **search/browse/stats only**, not an install path. No change.
- Existing tests: `skills.test.ts` (provider mocks), `skills-bash-detection.test.ts` (module-level `vi.mock('node:child_process')`, `fs/promises`, `./workspace.js`). `scripts/shell/tests/external-skills-smoke-test.sh` is a live skills.sh search/browse check against a running API (needs internet); unrelated to install, unaffected.
- I found no persistence of installed external refs outside the workspace files (grep of worker/api). That matters for T3.2/T4.3, not T0.5.

**Real CLI with a local path:** supported — skills@1.5.25 `parseSource` treats absolute/`./` paths as `type: "local"` (select a skill with `--skill`). Not used for the test: `npx` resolves the package from the npm registry unless cached (cache is per-user, not in repo/CI), the CLI sends telemetry unless `DISABLE_TELEMETRY=1`, and wiring it in would need a production ref-rewrite. Recorded as the manual operator check for post-push/T4.3 notes only; not run.

### Design: smallest seam, existing pattern

Mirror `ToolContext.externalSkillProvider`: an optional injected port on `ToolContext`, defaulting to today's CLI behaviour.

1. **Add** `packages/domain/src/ports/external-skill-installer.ts`:
   ```ts
   export type ExternalSkillInstallResult = { ok: true; output: string } | { ok: false; error: string };
   /** Installs an external skill into an agent workspace (`<workspaceRoot>/.agents/skills/<name>/`). */
   export interface ExternalSkillInstaller {
     /** `ref` is the normalized skills-CLI form, e.g. `owner/repo@skill`. */
     install(ref: string, workspaceRoot: string): Promise<ExternalSkillInstallResult>;
   }
   ```
   Export from `packages/domain/src/ports/index.ts`. Install only (YAGNI): list/remove join the port when a test needs them.
2. **Modify** `packages/domain/src/tools.ts` `ToolContext`: `externalSkillInstaller?: import('./ports/external-skill-installer.js').ExternalSkillInstaller;` next to `externalSkillProvider`.
3. **Modify** `apps/worker/src/tools/skills.ts`:
   - `export const npxSkillsCliInstaller: ExternalSkillInstaller = { install: (ref, cwd) => runExternalSubprocess(['add', ref, '--yes'], cwd, EXTERNAL_INSTALL_TIMEOUT_MS) };`
   - `runExternalSkillInstall(ref, cwd, installer)` normalizes once and calls `installer.install(normalized.ref, cwd)`; `add_skills` passes `ctx.externalSkillInstaller ?? npxSkillsCliInstaller`. Spawn args, env, timeout and sequencing unchanged → production behaviour identical, no wiring change in `agent.ts`.
   - Reuse `ExternalSkillInstallResult` for `ExternalSubprocessResult` (alias).
   - Export `normalizeExternalRef` only if the installer needs it (it should not; it receives the normalized form).
4. **Add** `apps/worker/src/tools/local-directory-skill-installer.ts` — `class LocalDirectorySkillInstaller implements ExternalSkillInstaller`, constructor `{ sourceRoot: string }`. Header: "not wired in production; used by tests and T4.3 (D20: the live CLI cannot see local work)".
   - Parse `owner/repo@skill`; each segment must match `^[A-Za-z0-9._-]+$` and not be `.`/`..` → else `{ ok:false, error:'unsupported external skill ref: …' }` (no traversal).
   - Source = `<sourceRoot>/<owner>/<repo>/skills/<skill>/` (the `github.com/<owner>/<repo>` + `skills/<name>/SKILL.md` layout used by openaidom-skills/traderton-skills). Missing `SKILL.md` → `{ ok:false, error:'skill not found in local source: <ref>' }`.
   - `parseSkillFrontmatter` (existing export); require `name` + `description` (CLI parity); install dir = CLI `sanitizeName` equivalent (`lowercase`, `[^a-z0-9._]+`→`-`, trim `.-`); `fs.cp(source, <root>/.agents/skills/<dir>, { recursive: true })`; `{ ok:true, output:'Installed <name> from local source' }`.
5. **Add** fixture skills under `apps/worker/src/tools/__fixtures__/external-skill-source/` (the doubled `skills` is repo name + `skills/` subdir):
   - `example/skills/skills/echo/SKILL.md`
     ```md
     ---
     name: echo
     description: Test-only fixture skill for the fictional example-echo external backend. Never publish.
     ---
     # Echo (test fixture)

     Test fixture for network-free external-skill installation (Phase 3 T0.5).
     Use the `echo_text` tool to return the supplied text unchanged.
     ```
   - `example/skills/skills/echo-shell/SKILL.md` — same, `name: echo-shell`, plus `allowed-tools: Bash(echo:*)` (exercises the post-install reader).
   Single-line `description` (the existing frontmatter parser does not handle `>-`).
6. **Add** `apps/worker/src/tools/skills-local-source.test.ts` — `describe('add_skills with a local fixture skill source')`:
   - Setup: `vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('skills CLI must not be spawned'); }) }))`; temp workspace via `mkdtemp` + `vi.stubEnv('AGENT_WORKSPACE_ROOT', tmp)`; minimal ctx (redis/publishToInbound mocks as in `skills-bash-detection.test.ts`; no `as unknown as`); `externalSkillInstaller: new LocalDirectorySkillInstaller({ sourceRoot: fileURLToPath(new URL('./__fixtures__/external-skill-source/', import.meta.url)) })`; cleanup `rm -rf tmp`, `vi.unstubAllEnvs()`.
   - `it('installs example/skills/echo end-to-end from the fixture source without spawning the CLI')` — `includeDependencies: false`; `success`, `data.added` contains the ref, `data.external[0].ok`; `<tmp>/.agents/skills/echo/SKILL.md` bytes equal the fixture; `spawn` not called.
   - `it('feeds the installed SKILL.md to the post-install Bash detection')` — `example/skills/echo-shell`, default `includeDependencies`; broker reply mock `ok`; a `MANAGE_AGENT_SKILLS` publish includes `programming`; `autoResolved` lists `system/programming`.
   - `it('reports a typed failure for a ref absent from the local source')` — `example/skills/missing` → `external[0].ok === false`, warning mentions "not found".
   - `it('rejects a path-traversal ref')` — installer unit: `install('../x@y', tmp)` → `ok:false`, nothing written.
   - `it('without an injected installer, keeps spawning `npx skills add <owner/repo@skill> --yes`')` — no `externalSkillInstaller`; `spawn` called with `('npx', ['skills','add','example/skills@echo','--yes'], objectContaining({ cwd: tmp }))` (the mock throws → graceful `ok:false`). Proves the default path and D11-style normalization are unchanged.

### Steps

1. Port + `ToolContext` field (domain). 2. skills.ts seam (worker). 3. `LocalDirectorySkillInstaller`. 4. Fixture skills. 5. Test. 6. Run existing skills tests unchanged. 7. Append P3-n to `DECISIONS.md` (seam choice + why not the real CLI) and flag the T4.1 constraint below in `TASKS.md` running notes; T0.5 ✅. 8. Commit (hb only).

### Verify

```sh
pnpm exec vitest run apps/worker/src/tools/skills-local-source.test.ts apps/worker/src/tools/skills.test.ts apps/worker/src/tools/skills-bash-detection.test.ts packages/domain/src/__tests__/skill-catalog-types.test.ts
pnpm --filter @herobids/domain --filter @herobids/worker run build    # real type-check of the source change
pnpm lint
```
No env var or config added → no `.env.example` change (I11 unaffected).

---

## Risks / open questions (none blocking)

1. **`pnpm lint` likely type-checks nothing** and test files are in no tsconfig. Mitigation above (build + I7 grep). Worth an `ESCALATIONS.md`/Outstanding-Issues LOW row; not fixed here (out of scope).
2. **Generators in `scripts/ts/` are not type-checked** (no tsconfig). Acceptable for one-off tooling; T1.1 must repoint the signing generator's relative import.
3. **Byte stability across checkouts:** no `.gitattributes`; a CRLF-converting checkout would break both digests. Optional follow-up (Outstanding Issues): `**/__fixtures__/** -text` in both repos.
4. **Step 10 §3 amendment** (P3-n) is a contract clarification, so it goes in before the fixtures per SEAM §4; it does not touch §5 REST bytes.
5. **T4.1 constraint:** each `SKILL.md` frontmatter `name` must sanitize to the ref's skill segment (`crypto-trading`, …). The CLI names the install dir from `name`; herobids `deriveSkillDirName` uses the ref segment. A mismatch silently breaks post-install reads.
6. **Fixture installer ≠ CLI:** it models the canonical-dir copy only (no symlinks/agent dirs, no remote discovery). Real-remote resolution stays deferred to the post-push operator step (D20); T4.3 must say so rather than report a CLI green.
7. **T0.6 interaction:** `client-signing-vectors.test.ts` pins the client's envelope bytes when all ids are supplied; T0.6 must keep it green (it should, since it only changes which caller supplies ids).
