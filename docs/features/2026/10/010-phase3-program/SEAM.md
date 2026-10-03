# Phase 3 — SEAM: the cross-repo contract (pointer, not a copy)

**Status:** living. **This file does NOT restate the contract.** A second copy of
a contract IS the drift it exists to prevent.

## 1. Where the contract lives (normative)

| Concern | Normative source | Do not duplicate it |
|---|---|---|
| `ExternalBackendDefinition` shape | Step 10 plan **§1** | — |
| `ExternalBackendClient` rename map | Step 10 plan **§2** | — |
| **Transport seam** (what's above vs below) | Step 10 plan **§2.4** | — |
| **MCP wire mapping** (field-by-field) | Step 10 plan **§2.5** + ADR 016 §Decision 5 | — |
| Descriptor shape + verification pipeline | Step 10 plan **§3** | — |
| Key rotation / revocation | Step 10 plan **§4** | — |
| **Frozen REST bytes** | Step 10 plan **§5** | — |
| Failure behaviour | Step 10 plan **§6** | — |
| Descriptor as sole schema authority | Step 10 plan **DT4** + D16 | — |

Step 10 plan: `../../09/24/006-step10-external-backend-contract-and-trust-plan.md`
ADR 016: `../../../../tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md`

**If this file and the Step 10 plan ever disagree, the Step 10 plan wins** and
this file is the bug.

## 2. Why a shared fixture, not a shared document

The existing anti-drift guard is weaker than it looks.
`herobids/packages/domain/src/traderton/sign.test.ts:28-36` (pre-T0.3 line
numbers; the header was re-annotated at T0.3 and now points here) hand-replicates
the traderton verifier inline (`verifierCanonical`, `verifierSignature`) with a
comment claiming:

> "If a message signed here verifies against this replica, it verifies against
> the real `authenticateRequest`."

That claim is **unfalsifiable from inside herobids.** If
`traderton/packages/boundary/src/auth.ts` changes, the herobids test still
passes. The replica cannot detect the one failure it exists to prevent.

Duplicated *code* is drift-blind. Duplicated *data* is drift-detecting. Hence
shared fixtures.

Note also why this matters more than it did in Phase 2: Phase 2's cross-repo work
was **content** (docs, static HTML) where the worst drift symptom is a broken
link. Phase 3's is a **contract**, where the drift symptom is a fail-closed
boundary returning `authentication.invalid_caller` — which
`traderton/packages/boundary/src/auth.ts` marks permanently **non-retryable**.

## 3. The fixtures

### 3.1 `invocation-signing-vectors.json`

Created at **T0.3, against PRE-RENAME code.** Captured after the rename it pins
post-rename bytes and proves nothing about the rename.

| Repo | Path | Asserts |
|---|---|---|
| herobids | `packages/domain/src/external-backend/__fixtures__/invocation-signing-vectors.json` | the signer emits exactly these bytes |
| traderton | `packages/boundary/src/__fixtures__/invocation-signing-vectors.json` | the verifier accepts them, and rejects a one-byte mutation |

Required cases:
1. `POST` invoke with a full envelope body.
2. `GET` status with an **empty** body.
3. A path carrying a **query string** — must be stripped before signing.
4. A **non-ASCII** body (UTF-8 byte-length vs character-length).

Each case records the method, the path as signed, the timestamp, the body bytes,
the expected canonical string and the expected `sha256=<hex>` signature.

**Both repos additionally assert a SHA256 digest of the fixture file itself**, so
editing one copy fails on both sides rather than silently diverging.

```
Fixture digest (filled at T0.3):
  invocation-signing-vectors.json  sha256 = 1d4a04b8e92c2baddea4fc8fef787a310d756cfa621d88c11609ad0f9d0520ef
```

(Moved at T1.1 (C1) from `packages/domain/src/traderton/__fixtures__/`, bytes unchanged.)

### 3.2 Descriptor conformance fixtures

Created at **T0.4**. One valid signed descriptor plus tampered variants, each of
which must degrade the skill to instruction-only (Step 10 DT3):

| Variant | Expected |
|---|---|
| valid | tools exposed |
| bad signature | instruction-only |
| wrong `backendId` | instruction-only |
| `expiresAt` in the past | instruction-only |
| `ref` not in `approvedSourceSkillRefs` | instruction-only |
| unknown `keyId` | instruction-only |
| pin digest mismatch | instruction-only |
| `tools/list` disagrees with the descriptor | instruction-only (D16) |

T0.4 added six rows to the fixture's variant set (14 variants in
`manifest.json`): three **positive controls** that must expose tools —
`valid-pinned` (pin equals the digest), `retiring-key-accepted` (key
`status: "retiring"`, Step 10 §4 overlap) and `tools-list-agrees` — so a pipeline
that always fails pinned mode, retiring keys or the cross-check cannot pass the
matching negatives trivially; two more `tools/list` cross-check negatives —
`tools-list-schema-disagrees` (only an `inputSchema` property description
differs) and `tools-list-extra-tool` (one tool the descriptor does not declare);
and `definition-disabled` (`enabled: false`, Step 10 §4 revocation →
instruction-only).
The fixtures encode Step 10 §3 "Canonicalization and encoding" (P3-3) and use a
fictional generic backend (`example-echo`), not trading tool shapes.

| Repo | Path | Asserts |
|---|---|---|
| herobids | `packages/domain/src/external-backend/__fixtures__/descriptor-conformance/` | well-formed (always on); the verification pipeline reaches each variant's `expected.outcome` (`describe.skip` until T3.1) |
| traderton | `packages/boundary/src/__fixtures__/descriptor-conformance/` | well-formed: same JCS bytes, ed25519 encoding and `tools/list` cross-check rule |

(Moved at T1.1 (C1) from `packages/domain/src/traderton/__fixtures__/descriptor-conformance/`, bytes unchanged.)

```
Fixture digest (filled at T0.4):
  descriptor-conformance/  sha256 = 823ceb2ba634fc6df21e53e82549f3db63a8fdb19caaf52fdaf5d80d60910766
```

**Digest rule.** Files = entries directly in the directory whose name matches
`^[a-z0-9.-]+\.json$` (no subdirectories; dotfiles such as `.DS_Store`
excluded), names sorted with JS default sort (= byte order for these ASCII
names); sha256 over the concatenation of `name + "\n" + <file bytes> + "\n"` per
file; lowercase hex. `DESCRIPTOR_CONFORMANCE_DIR_SHA256` in both
`descriptor-conformance.test.ts` files holds the same value. Shell equivalent:

```sh
cd <dir> && for f in $(ls | grep -E '^[a-z0-9.-]+\.json$' | LC_ALL=C sort); do printf '%s\n' "$f"; cat "$f"; printf '\n'; done | shasum -a 256
```

Regenerating (herobids `scripts/ts/generate-descriptor-conformance-fixtures.ts`)
uses a fresh ephemeral ed25519 key — only the public key is written; the private
key is discarded — so it changes every signature and the digest. It is a §4
contract change: `cp -R` the directory to traderton and update both constants and
this digest together.

### 3.3 Local fixture external-skill source

Created at **T0.5**. Required because herobids resolves external skills **live
and unpinned at runtime** — `apps/worker/src/tools/skills.ts:37` spawns
`npx skills add <ref> --yes`, and `normalizeExternalRef` maps the D11 ref
`traderton/skills/crypto-trading` to `traderton/skills@crypto-trading`. Step 13's
work stays local (D20), so the real CLI **cannot see it**, and Step 10 §7 task 17
is unsatisfiable without a fixture source.

## 4. The change rule

Changing anything in §1 is a **cross-repo contract change**. The sequence is
fixed:

1. **Amend the Step 10 plan first** (and ADR 016 if the change touches a decision
   it records). The document changes before the code.
2. **Update the fixtures in BOTH repos in the same change**, including the digests
   recorded above and in this file.
3. **Run both repos' suites.** A change that passes in one repo and not the other
   is the drift this file exists to catch, not a flaky test.
4. **Record it** in this package's `DECISIONS.md` with the before/after.

**The REST path is exempt from step 1 in one direction only: it may not change at
all.** Step 10 §5 freezes it. If making MCP work appears to require editing
`sign.ts` canonical-string construction, header names or body serialization,
**stop and re-open ADR 016** (ENTRYPOINT §6 hard stop 3). `McpTransport` reuses
the signing module; it does not refactor it.

## 5. Spike gates (ADR 016 §Consequences; Step 10 §2.5)

Both must pass before any MCP implementation lands.

**Gate 1 — `params._meta` is inside the signed bytes. HARD STOP if it fails.**
Assert that `initialize`, an SDK-originated notification, and `tools/call` all
pass the backend's `authenticateRequest`, and that `params._meta` is inside the
hashed body. If the SDK serializes `_meta` where a signing middleware cannot see
it, or omits it from the body, the signature does not cover the envelope and the
D15 mapping is invalid. **Stop and re-open ADR 016 — do not work around it.**

**Gate 2 — coexistence.** The MCP route mounted on traderton's existing app, with
`app.test.ts` and `boundary.verification.integration.test.ts` passing
**unmodified** and the `addContentTypeParser` raw-body retention untouched.
