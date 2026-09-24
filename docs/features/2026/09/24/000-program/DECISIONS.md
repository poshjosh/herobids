# Program Decision Log + Contemplator Handoff

**Status:** living. **Read ENTRYPOINT.md §6 for when to route a decision here.**
**Updated:** 2026-09-24

## Decisions made (do not relitigate — treat as settled unless a later decision supersedes them)

| # | Decision | Status | Recorded where |
| --- | --- | --- | --- |
| D1 | Dedicated Traderton VM in same Hetzner location/private network (max isolation over minimal latency) | Settled | this file |
| D2 | Release pair pinned to exact SHAs before build — record herobids + traderton commit SHAs (and built image digests), verify each clean + pushed, and deploy those immutable refs (never a moving `main` HEAD) | Settled | this file |
| D3 | Terms: **External Backend**, `ExternalBackendDefinition`, `ExternalBackendClient`, External Backend Descriptor | Settled | ADR 015 |
| D4 | MCP deferred (later packaging over the External Backend contract, not the first transport) | Settled | ADR 015 |
| D5 | Staging-first sequencing; generic External Backend refactor comes after staging operational proof | Settled | roadmap + ADR 015 |
| D6 | No migration/compatibility period — greenfield (no production/customer deployment or data; staging state to be confirmed by inspection) | Settled | this file |
| D7 | `venue-capability.ts` → Traderton; `trading-protocol.ts` → split; `traderton/` → generalize/delete | Settled (direction) | ADR 015 §Initial Module Disposition |
| D8 | Traderton frontend later; execution boundary stays private; `staging.traderton.com` public site for docs/status only | Settled | roadmap |
| D9 | Superseded `RemoteBoundary` plan is non-governing history | Settled | ADR 015 + plan header |
| D10 | Step 16 retains the mandatory REST differential and representative load test. Use read-only Herobids oracle `1f6978d740d45e466cf4149617b8afc1c721e751` (the parent of trading-package removal); prior A8/C5/soak evidence supports but does not replace these reports. | Settled | roadmap Step 16 + traderton 004/007/024 |

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
- Canonical Traderton skills.sh publisher/repository ref (needed at Phase 3 step 13).
- Which Herobids trading UI/API/billing/SEO surfaces may remain generic vs must be removed (needs legal/payment-provider input — Phase 2 step 8).