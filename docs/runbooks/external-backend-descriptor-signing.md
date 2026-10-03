# Runbook — External Backend descriptor signing (dev scheme + production key / CF-9)

**Status:** SUPERSEDED 2026-10-03 by [ADR 017](../tech/architecture/adrs/2026/10/017-uniform-skills-sh-skills-and-mcp-tool-discovery.md) / D26. The descriptor and signing are removed in Phase 4, and this runbook is deleted with them. CF-9 is closed as N/A. Until that change lands, Part A still describes the code on `main`.
**Audience:** a developer regenerating the dev descriptor, or an operator doing the
production-key step (CF-9).
**Design references (read these for *why*, not *how*):**
[External Backend architecture overview](../tech/architecture/external-backend.md) ·
[ADR 015](../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md) ·
[ADR 016](../tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md) ·
Step 10 contract §3 (descriptor) / §4 (rotation):
`docs/features/2026/09/24/006-step10-external-backend-contract-and-trust-plan.md`.

## What this is

herobids exposes an External Backend's tools only if that backend's **signed
descriptor** verifies against a **trusted ed25519 public key** in operator config.
The descriptor is the sole authority for the backend's tool schemas (D16/DT4). A
trust failure degrades the skill to instruction-only — it never crashes.

There are two signing regimes:

| | DEV (today) | PRODUCTION (CF-9 — not yet done) |
|--|-------------|---------------------------------|
| Private key | ephemeral, generated locally, **gitignored** | operator-held, in a secrets manager, never in the repo |
| Public key | committed in `config/default.yaml` | registered in operator-managed config |
| Descriptor | committed `traderton.descriptor.json`, dev-signed | signed by the real key; ideally published by Traderton |
| Who runs it | any developer | an operator (infrastructure mutation, D20) |

---

## Part A — the DEV scheme (current state)

### Files

| Path | Committed? | Role |
|---|---|---|
| `config/external-backends/traderton.descriptor.json` | ✅ yes | the signed `{descriptor, signature, keyId}` wrapper the worker serves to trading agents; loaded at startup. keyId `traderton-dev-1`. |
| `config/external-backends/traderton.descriptor.pub.pem` | ✅ yes | the PEM SPKI public key that verifies the wrapper. Its contents are also pasted into `config/default.yaml`. |
| `config/external-backends/traderton.descriptor.dev-key.pem` | 🚫 **gitignored** | the ed25519 **private** key. Exists only on the machine that last ran the generator. Needed only to re-sign; the runtime verifies with the public key alone. Pattern: `config/external-backends/*.dev-key.pem` in `.gitignore`. |

The committed public key also lives in
`config/default.yaml → externalBackends.traderton.trustedDescriptorSigningKeys[0]`
(keyId `traderton-dev-1`, `status: active`). **No setup is needed for dev/test** —
a fresh checkout works because both the descriptor and the public key are committed.

### When you must regenerate

Regenerate whenever the committed descriptor would drift from what the code
exposes — i.e. when the **built-in trading tool set or a tool's catalog
`category`/`description` changes** (the descriptor binds the three D11 refs →
those tool schemas; a drift fails the DT4 category cross-check at runtime). You do
**not** need to regenerate for unrelated changes.

### How to regenerate (as a set — this is the one gotcha)

The generator mints a **fresh keypair each run** (non-deterministic). So the
signature, the public key, and the config value must all be updated together.

```bash
# from the herobids repo root
pnpm --filter @herobids/scripts run generate-dev-descriptor
```

This rewrites all three files above and prints the new public key. Then:

1. Copy the printed PEM block into `config/default.yaml` at
   `externalBackends.traderton.trustedDescriptorSigningKeys[0].publicKey` (keep
   `keyId: traderton-dev-1`, `status: active`). The config key MUST match the key
   that signed the committed descriptor, or verification fails.
2. Commit `traderton.descriptor.json`, `traderton.descriptor.pub.pem`, and the
   `config/default.yaml` edit **together**. Do **not** commit the `*.dev-key.pem`
   (gitignore enforces this; verify with `git status`).
3. Verify: `pnpm --filter @herobids/domain build` then
   `pnpm exec vitest run apps/worker/src/external-backend` — the
   `file-descriptor-source` + `descriptor-tool-visibility` parity tests confirm
   the committed descriptor verifies under the committed key and exposes the
   expected tool set.

Source of truth for the mechanics: `scripts/ts/generate-dev-descriptor.ts`
(its header documents the determinism rule and the exact outputs).

---

## Part B — the PRODUCTION key (CF-9) — NOT yet done

**CF-9** is a carried-forward obligation recorded in
`docs/features/2026/10/02/005-phase3-program/DECISIONS.md §5`: *"Real
operator-held ed25519 descriptor signing key; registering it is an infra
mutation."* It is deliberately **not implemented** — generating/registering a real
key is an infrastructure mutation gated behind operator approval (D20), so Phase 3
stopped at the dev scheme. This section is the actionable procedure for when it is
picked up (Step 16 / pre-launch).

### Goal

Replace the dev-signed trust anchor with a real, operator-controlled one, so the
descriptor herobids trusts is signed by a key no developer ever held.

### Procedure (operator)

1. **Generate the real keypair on an operator-controlled host**, not in the repo:
   ```bash
   openssl genpkey -algorithm ed25519 -out traderton-prod.key          # private — secrets manager only
   openssl pkey -in traderton-prod.key -pubout -out traderton-prod.pub  # public — safe to register
   ```
   Store the private key in the secrets manager (never in git, never on a dev
   machine). Choose a new `keyId` (e.g. `traderton-prod-1`) — rotation always
   introduces a new keyId (Step 10 §4).
2. **Decide who signs the descriptor.** Preferred end state: **Traderton publishes
   its own signed descriptor** (herobids only verifies). Interim: an operator
   signs the descriptor with the real key using the same canonicalization the
   verifier uses — ed25519 over `UTF-8(JCS(descriptor))` (see
   `packages/domain/src/external-backend/descriptor.ts` `canonicalizeJcs` /
   `verifyDescriptorSignature`; the dev generator shows the exact signing call).
3. **Register the real public key** in the operator-managed config's
   `externalBackends.traderton.trustedDescriptorSigningKeys` (production config
   layer, not `config/default.yaml`). Use `status: active`; during a rotation keep
   the old key `status: retiring` for the overlap window (Step 10 §4).
4. **Retire the dev key:** remove the `traderton-dev-1` entry and delete the
   committed dev descriptor + `*.pub.pem` from the production config path once the
   real descriptor is in place. (Leaving the dev key trusted in production would
   mean a leaked dev private key could forge tool schemas.)
5. **Verify** against the real descriptor the same way Part A step 3 does, plus the
   production trust path, before any traffic.

### What "done" looks like

- No dev-signed descriptor or dev public key is trusted in production config.
- The descriptor herobids trusts in production is signed by the operator-held key;
  the private key exists only in the secrets manager.
- `descriptorPinning` / expiry / rotation behave per Step 10 §3/§4.

### Related carried items

- **CF-8** — the push gate (nothing in `traderton` / `traderton-skills` is pushed
  yet); the real descriptor ideally comes from a pushed, operator-controlled
  Traderton publication.
- **Step 10 §4** — rotation/revocation semantics (overlap window, `retiring`
  status) the production key must follow.

---

## Where this runbook is referenced from

`config/default.yaml` (inline comment on `trustedDescriptorSigningKeys`), the
[architecture overview](../tech/architecture/external-backend.md), and the CF-9
row in `docs/features/2026/10/02/005-phase3-program/DECISIONS.md §5` all point
here, so whichever entry point a future worker starts from lands on this
procedure.
