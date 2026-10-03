# Program Decision Log + Contemplator Handoff

**Status:** living. **Read ENTRYPOINT.md §6 for when to route a decision here.**
**Updated:** 2026-10-03 (D21–D29 added; D12, D16, D19, D20 and DT1/DT3/DT4 partly superseded, see those rows)

## Decisions made (do not relitigate — treat as settled unless a later decision supersedes them)

| # | Decision | Status | Recorded where |
| --- | --- | --- | --- |
| D1 | Dedicated Traderton VM in same Hetzner location/private network (max isolation over minimal latency) | Settled | this file |
| D2 | Release pair pinned to exact SHAs before build — record herobids + traderton commit SHAs (and built image digests), verify each clean + pushed, and deploy those immutable refs (never a moving `main` HEAD) | Settled | this file |
| D3 | Terms: **External Backend**, `ExternalBackendDefinition`, `ExternalBackendClient`, External Backend Descriptor | Settled | ADR 015 |
| D4 | ~~MCP deferred (later packaging over the External Backend contract, not the first transport)~~ — **SUPERSEDED by D13/D14 + ADR 016** (2026-10-02). Retained for history; do not act on it. | Superseded | ADR 015 §8 → ADR 016 |
| D5 | Staging-first sequencing; generic External Backend refactor comes after staging operational proof | Settled | roadmap + ADR 015 |
| D6 | No migration/compatibility period — greenfield (no production/customer deployment or data; staging state to be confirmed by inspection) | Settled | this file |
| D7 | `venue-capability.ts` → Traderton; `trading-protocol.ts` → split; `traderton/` → generalize/delete | Settled (direction) | ADR 015 §Initial Module Disposition |
| D8 | Traderton frontend later; execution boundary stays private; `staging.traderton.com` public site for docs/status only | Settled | roadmap |
| D9 | Superseded `RemoteBoundary` plan is non-governing history | Settled | ADR 015 + plan header |
| D10 | Step 16 retains the mandatory REST differential and representative load test. Use read-only Herobids oracle `1f6978d740d45e466cf4149617b8afc1c721e751` (the parent of trading-package removal); prior A8/C5/soak evidence supports but does not replace these reports. | Settled | roadmap Step 16 + traderton 004/007/024 |
| D11 | Traderton skills.sh source: repo `github.com/traderton/skills` (local `/Users/chinomso.ikwuagwu/dev_ai/traderton-skills/`). Three skill refs: `traderton/skills/crypto-trading`, `traderton/skills/crypto-bot-management`, `traderton/skills/crypto-risk-monitoring` — mapping to the herobids seeds TRADING_SKILL / BOT_MANAGEMENT_SKILL / RISK_MONITORING_SKILL respectively. These are the `approvedSourceSkillRefs`. (Resolves the DECISIONS open item "canonical Traderton skills.sh publisher ref".) | Settled (operator, 2026-10-02) | this file |
| D12 | Phase-3 scope NARROWED (operator, 2026-10-02): execute Steps 10, 11, 12, 13 now (ExternalBackend machinery + Traderton skill publication). DEFER Steps 14 (remove herobids first-party trading), 15 (trading-domain module move/split), and 16 (final staging proof — also infra-gated). Steps 11/12 route trading through the generic path but do NOT remove/relocate trading from herobids yet. **AMENDED by D14** (2026-10-02): scope additionally includes the transport seam, `McpTransport`, and a Traderton MCP server surface. Steps 14/15/16 remain deferred. | Settled (operator) | this file |
| D13 | **MCP is the target invocation transport for platform-managed External Backends.** ADR 015 §8 and D4 are superseded on direction. The authenticated-private-invocation, health, idempotency, descriptor-trust and authorization requirements §8 named are RETAINED — they live above the transport seam, not in the transport. Rationale: both product halves need MCP regardless (assistant connectors are an MCP ecosystem); an independently consumable Traderton is stronger isolation evidence than a self-signed artifact; and Step 9 found the transport was never the hard part. MCP supplies NO entitlement model — that layer stays ours (D16). | Settled (operator, 2026-10-02) | ADR 016 §Decision 1 |
| D14 | **`McpTransport` is built in Phase 3, alongside `RestTransport`** (operator direction, overruling a Contemplator ruling that deferred it). Rationale: a seam with one implementation is an unvalidated abstraction; two implementations force the broader design. Consequence accepted: a Traderton MCP server surface and the MCP-path verifier work enter Phase-3 scope, amending D12. The transport seam is INTERNAL to `packages/domain/src/external-backend/` and not exported, so redirecting it later is not a breaking change for its importers. | Settled (operator, 2026-10-02) | ADR 016 §Decision 2–3 |
| D15 | **MCP wire mapping = native tools, not an envelope tunnel.** `tools/call` carries `{ name: <toolName>, arguments: <payload> }`; platform-owned envelope fields travel in `params._meta`; the signature binds `POST\n<mcp path>\n<timestamp>\nSHA256(body)` over the whole JSON-RPC frame including `_meta`; header↔body assertions retained reading from `_meta`; `tools/list` served verbatim from the signed descriptor; failures RETURN `isError: true` with the failure envelope in `structuredContent` (never throw — a thrown error becomes a JSON-RPC protocol error and the closed failure-code union is lost); `in_progress` resolved by re-issuing `tools/call` with the same `idempotencyKey` (no status endpoint needed on the MCP path); Tasks extension NOT adopted (experimental). Rejected: an envelope tunnel is unusable by any third-party MCP client, forfeiting the interoperability that motivates D13, and leaves the seam unvalidated. | Settled (2026-10-02) | ADR 016 §Decision 5 |
| D16 | **The verified External Backend Descriptor is the SOLE authority for tool `name`, `description`, `inputSchema`, `category`.** Any `tools/list` is cross-checked or ignored — never a schema source; disagreement is a trust failure degrading to instruction-only (DT3). Rationale: MCP tool descriptions enter the model context directly, so an unverified `tools/list` from an order-placing backend is a tool-poisoning surface. This is also what keeps Step 12's visibility path transport-independent. | Settled (2026-10-02) | ADR 016 §Decision 4; Step 10 DT4 |
| D17 | **MCP protocol code uses the official SDK's scoped v2 packages, pinned exact** (`@modelcontextprotocol/client` in herobids; `server` + framework adapter in a backend). The monolithic `@modelcontextprotocol/sdk` is NOT adopted (17 direct deps incl. two HTTP frameworks + a second validator). Hand-rolling the protocol is rejected: it yields a private dialect resembling MCP without interop, forfeiting D13's rationale. A backend's surface builds on the **low-level `Server`**, not `McpServer` — `registerTool` will not take raw JSON Schema, and the descriptor's `inputSchema` already IS JSON Schema (preserves D16). | Settled (2026-10-02) | ADR 016 §Decision 8 |
| D18 | **The write-path idempotency defect (CF-1) is fixed in Phase 3, BEFORE the Step-11 rename** (operator direction, overruling a Contemplator ruling that carried it to Step 16). Defect: `packages/domain/src/traderton/client.ts:169-171` defaults `requestId`/`idempotencyKey` to `randomUUID()` and NO non-test call site supplies either, so the backend's `replay` branch is unreachable and a caller-level retry can duplicate an order. A stable key already exists in `payload.decisionId` and `write-adapter.ts` already plumbs both fields. Fixed before the rename for two reasons: it lands on current names and gets renamed with everything else, and it keeps Step 11 genuinely behaviour-neutral (Step 10 §7's own acceptance criterion). D15's `in_progress` resolution also DEPENDS on a stable key. | Settled (operator, 2026-10-02) | Phase-3 package step 3 |
| D19 | **REST remains the default and the only transport exercised in staging/production** until D10's differential is satisfied or explicitly re-scoped. A dev/test default of MCP would make the differential-critical path the least-exercised one. | Settled (2026-10-02) | ADR 016 §Decision 7 |
| D20 | **Phase-3 cross-repo write authority:** full author+commit in `herobids`, `traderton`, `traderton-skills`; **branch-scoped** (not local `main`); **ZERO pushes in any repo**; `openaidom-skills` read-only this phase. Branch commits are the reversibility net (traderton `008-decision-process.md` §6.2); undoing a local-`main` commit needs `git reset --hard`, which the agent may not run. A push to `github.com/traderton/skills` is an **infrastructure mutation**, not a docs commit: `apps/worker/src/tools/skills.ts:37` spawns `npx skills add <ref> --yes` and `normalizeExternalRef` maps the D11 ref to `traderton/skills@crypto-trading` — live, unpinned, at runtime, with no commit pin and no rollback target. Corollary: a local-only commit there is invisible to any running system, so **Step 13 CANNOT be verified through the real skills CLI** — it must use a local fixture source. A push to `traderton` `main` fires `.github/workflows/build-push.yml`, republishing `:latest` in a shared registry. | Settled (Contemplator + operator, 2026-10-02) | Phase-3 package ENTRYPOINT |

| D21 | **Phase 4 = replace `system/trading`, `system/bot-management`, `system/risk-monitoring` with the Traderton `SKILL.md` skills** (`traderton/skills/crypto-{trading,bot-management,risk-monitoring}`). D12 is lifted **for exactly the Phase 4 package scope**. Steps 15 and 16 stay deferred. Step 13 is re-recorded as **partial**: published, but herobids did not depend on it. Done = every frozen exit check passes (Phase 4 `INVARIANTS.md`); a check that cannot pass stops work for an operator ruling. | Settled (operator, 2026-10-03) | ADR 017; `docs/features/2026/10/03/004-phase4-skill-replacement-program/` |
| D22 | **The 2026-10-03 pushes are ratified.** herobids `main`, traderton `main` and `github.com/traderton/skills` `main` (`77fd7a5`) were merged and pushed by the operator. D20's "zero pushes" no longer describes the state. CF-8 is discharged. CF-14 is superseded by D23 (no `npx` resolution needed). | Settled (operator, 2026-10-03) | this file |
| D23 | **Every skills.sh skill follows one lifecycle:** on install, fetch the latest `SKILL.md` from the default branch and store its body and commit in the DB; re-fetch at agent start, falling back to the stored copy; show the commit in use. **No signing, digest or commit pinning.** The `traderton/skills` repo is public, so no credentials. | Settled (operator, 2026-10-03) | ADR 017 §1 |
| D24 | **External skills use progressive disclosure:** the system prompt lists `name` and `description`; a `read_skill` tool loads the body; a loaded skill stays in the prompt for the session. Built-in `system/*` skills stay injected in full. | Settled (operator, 2026-10-03) | ADR 017 §2 |
| D25 | **Backend-approved skills differ only in what they unlock**, and approval is driven by operator config, not by any identity check. The backend's tools for the skill come from its **MCP `tools/list`**, with each tool tagging its skill ref(s) in a neutral-namespace `_meta` key. A required connection family is declared per approved ref in operator config. **Supersedes D16** and ADR 016 Decision 4. | Settled (operator, 2026-10-03) | ADR 017 §3–§4 |
| D26 | **The descriptor and signing machinery is removed** (schema, trust pipeline, `config/external-backends/*`, signing keys and pinning in config, `generate-dev-descriptor.ts`, conformance fixtures in both repos, signing runbook). **Supersedes DT1, DT3 and DT4** and Step 10 plan §3–§4. CF-9 is closed as N/A. New degradation rule: backend unreachable at start → tools hidden, skill text still loadable, no crash. | Settled (operator, 2026-10-03) | ADR 017 §5 |
| D27 | **D19 amended:** MCP may be used for tool *discovery* (`tools/list`) in all environments. Tool *calls* stay REST in staging and production until the Step 16 differential. | Settled (operator, 2026-10-03) | ADR 017 §4 |
| D28 | **`trading` stays an opaque connection-family label** in Phase 4, declared by operator config for the approved refs. Backend-defined families and generic product wording are named follow-ups. | Settled (operator, 2026-10-03) | ADR 017 §6 |
| D29 | **Accepted Phase 4 rulings:** model-facing tool schemas move later (follow-up F-1); intentional divergences IV-a..IV-e accepted; `SKILL.md` frontmatter cleaned to the Agent Skills spec; removal of `system/trading*` seeds is safe without inspecting staging, because staging will be torn down and restarted; herobids tests must not contain copies of Traderton skill text; herobids may store and display Traderton-authored skill text; a light Traderton 008 process applies (the pre-decision analysis plus independent review served as the brief). | Settled (operator, 2026-10-03) | Phase 4 package |
## Contemplator handoff protocol

When ENTRYPOINT §6 triggers, spin off a fresh Contemplator (do not decide
in-context). Provide it this context first, then the neutral brief below.

### Context to give Contemplator (verbatim, before the brief)

- **Strategic objective:** ENTRYPOINT.md §1 — Herobids is a generic agent host; Traderton owns trading. Legal isolation is the top priority.
- **Invariants:** ENTRYPOINT.md §4 — in particular: no infra mutation without approval; ownership boundary; no backward-compat obligation; parity-not-liveness.
- **Relevant prior decisions:** the relevant rows from DECISIONS.md §Decisions made, and any ADR.
- **Instruction:** decide, do not defer; rank options against the invariants; if a fact is missing, name the path to check rather than assume; explicitly state which invariant an option honours or violates.

### Neutral brief (fill every section; facts, not conclusions)

```
### Decision brief: <short title>

1. Strategic objective (verbatim from ENTRYPOINT §1)
2. Current step (from PROGRESS.md)
3. The question (neutral; no options, no lean)
4. Grounded facts (file:line or observed state; verifiable)
5. Candidate options A/B/C — each traced against the invariants, NOT ranked
6. What I could not determine (paths to check, not assumptions)
```

### After the ruling

1. If it **violates an invariant, contradicts a recorded decision, or accepts an
   infrastructure mutation**, require human ratification before acting.
2. If it honours the rules, record it in the table above and proceed.
3. Always update PROGRESS.md and, where relevant, the roadmap/ADR.

## Open questions (awaiting decision or operator input)

- S3 backend credentials / access for Terraform state inspection (Pass 1 needs
  `TF_BACKEND_BUCKET`, `TF_BACKEND_REGION`, `AWS_*`; the server IP itself is
  obtained from state, not a prerequisite).
- ~~Canonical Traderton skills.sh publisher/repository ref~~ — RESOLVED (D11).
- Which Herobids trading UI/API/billing/SEO surfaces may remain generic vs must
  be removed (needs legal/payment-provider input — Phase 2 step 8 / Phase 3 Steps
  14–15, now DEFERRED per D12).
- ~~Push gate: `github.com/traderton/skills` (and the `traderton` repo generally)
  are shared remotes~~ — RESOLVED and STRENGTHENED (D20): author+commit on a
  branch in all three repos; push remains a HARD STOP in each, with the per-repo
  mechanism now recorded.
- **Descriptor signing key (Step 13, DT1).** No ed25519 key material exists in
  any repo (verified: no matches in herobids/traderton `packages`, `apps`,
  `config`, `.env.example`; no `.pem` files). A **dev** keypair is
  agent-generated, local, gitignored — ephemeral local scaffolding, autonomous
  per ENTRYPOINT §4. The **real staging/production key is operator-held**, and
  registering a real public key into an operator-managed definition is an
  infrastructure mutation and is GATED. Step 13 completes with a dev-signed
  descriptor plus the recorded gate; real-key registration and the
  `traderton-skills` push are a single post-Phase-3 operator step (same shape as
  Phase 2's T4.2 greenlight).
- **Does the MCP route need operator approval?** Reading: adding a route to a
  backend's existing listener on the existing private path is not infrastructure
  mutation, so no. A separate port or a new firewall/ingress rule would be.
  Confirm the intended topology before the MCP work lands.
- **Is third-party MCP interop a near-term requirement for the trading backend
  specifically, or only for future assistant connectors?** Affects how much
  conformance headroom to build; does not affect D13/D15/D17.
- **Does legal/payment-provider review attach any weight to using an
  industry-standard protocol?** ADR 016 explicitly does NOT claim it does. If
  review says it matters, that strengthens D13's rationale but changes no
  engineering decision. The Phase-2 E1/E2/E3 batch did not cover this.