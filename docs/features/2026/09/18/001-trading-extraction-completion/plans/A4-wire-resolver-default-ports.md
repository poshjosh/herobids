# Plan A4: Wire the subject-resolver default ports (`getDefaultOwnerMode`, `getDefaultVenueAccountId`)

- **Task:** A4 — agent-direct actors always start at a `paper` escalation ceiling; owner-default venue resolution unwired
- **Repo:** traderton (`packages/boundary/src/bin.ts`, `subject-resolver.ts`)
- **Status:** PLAN — no implementation authorized. Decision-gated: **No** for the owner-mode wiring itself (defect); **B1-linked** for where the mode *value* should ultimately come from (see "B1 interaction").
- **Defect class:** Latent gate defect + missing operator knob (tracked by traderton's L3-Rx plan; audit §7 follow-ups).

## Context (verified against HEAD)

- `resolveNoBotOwnerMode` (subject-resolver.ts:146-158) for `actor.type === 'agent'` returns `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'`.
- `bin.ts`'s `resolverPorts` (bin.ts:227-241 area) define only `getBotById` + `listVenueAccountsByOwner` — **neither default port is wired**.
- Consequence 1 (mode): every agent-direct actor is constructed with `executionMode: injection.ownerMode = 'paper'` regardless of the agent's configured shadow/live mode. `checkModeEscalation`'s ceiling is therefore wrong for every non-paper agent — a live-entitled agent would be refused escalation to its real mode. Live enforcement today is mostly keyed off persisted config, so this is latent, not active — but it is a gate that will misfire the moment mode semantics matter (and it already mislabels `ctx.executionMode` in tool results).
- Consequence 2 (venue): `getDefaultVenueAccountId` unwired means multi-account owners rely entirely on the payload-supplied `venueAccountId` hint (herobids sends it — fixed in phase 1). Other consumers without the hint would hit "ambiguous". Operator knob missing.

## Approach

1. **Owner mode:** wire `getDefaultOwnerMode` in `bin.ts` from traderton's own operator config. Traderton has no agents table (locked), so the port cannot read per-agent mode. Options:
   - **(a) Static operator default** — return the venue-appropriate configured default from `config.execution`/live-rollout settings (e.g. traderton `config/default.yaml` already carries execution-mode-related blocks). Keeps the port honest ("operator-configured default owner mode for the no-bot path", per the type's doc).
   - **(b) Per-request mode from the consumer** — extend the payload/channel to carry the agent's mode (like the risk spec). More correct per-agent, more plumbing; **overlaps B1** (mode is part of the trading profile question).
   - **Recommendation:** (a) now — it un-gates the resolver and fixes the mislabeling; per-agent mode rides the B1 trading-profile decision rather than inventing a second channel now.
2. **Venue default:** wire `getDefaultVenueAccountId` from traderton's `venue_accounts` — semantics: the owner's oldest account (deterministic; creation-order tiebreak) or an explicit `is_default` column if traderton's schema has one (check `venue-accounts.ts` schema during implementation; if no column, oldest-by-`created_at` with a code comment, and note a possible small schema addition as follow-up).
3. Tests: resolver unit tests for both ports (already have the port seams fakeable — `subject-resolver.test.ts`); boundary-level test asserting an agent-subject `submit_decision` constructs the actor with the wired default mode.

## Verification

- Per-package tsc; traderton suite; live cross-stack re-run (part of A8 gate) asserting the boundary log `mode:` field reflects the wired default (not `paper`) for a shadow-configured agent.

## Risks / interactions

- **B1 interaction:** if B1 lands on traderton-owned trading profiles, per-agent mode comes from the profile and this static default becomes a fallback only. Wiring (a) now is forward-compatible; wiring (b) now would be throwaway.
- Venue-default choice (oldest account) is a policy guess — flag in the PR description; trivial to revisit.

## References

- `traderton/packages/boundary/src/subject-resolver.ts:146-158` (`resolveNoBotMode`), `:266-307` (default-venue branch)
- `traderton/packages/boundary/src/bin.ts` (resolverPorts block)
- `traderton/docs/features/L3-Rx-subject-resolver-venue-signal-plan.md` (the existing tracking doc)
- Audit §7 follow-up #2; bug-reports/2026/09/17 #001 companion report (ownerMode caveat).
