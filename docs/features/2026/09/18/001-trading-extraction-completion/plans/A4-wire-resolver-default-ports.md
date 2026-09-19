# Plan A4: Wire the subject-resolver default ports (`getDefaultOwnerMode`, `getDefaultVenueAccountId`)

- **Task:** A4 — agent-direct actors always start at a `paper` escalation ceiling; owner-default venue resolution unwired
- **Repo:** traderton (`packages/boundary/src/bin.ts`, `subject-resolver.ts`)
- **Status:** PLAN — **decisions recorded (2026-09-18); implementer-ready.** Decision-gated: **No** (defect fix; the B1-linked choice is resolved below).
- **Defect class:** Latent gate defect + missing operator knob (tracked by traderton's L3-Rx plan; audit §7 follow-ups).

## For the implementer (no prior context needed)

- **Repo:** traderton only. `../herobids` is READ-ONLY source. Read `traderton/AGENTS.md` + `traderton/docs/CANONICAL-STATE.md` at session start.
- Focused commits are allowed. Do not merge traderton into `main` without the approval required by its branch rules.
- All choices are decided below — implement as stated, do not re-open options. If the code contradicts the plan, stop and flag it.
- Verify per-package: `npx tsc --noEmit -p packages/boundary` (root lint has a build-cache blind spot). Full traderton suite green before done.
- This plan is **B1-forward-compatible**: B1 (ADR 010) makes per-agent mode come from the traderton trading profile later; the static default you wire here becomes the fallback. Nothing you build is throwaway.

## Context (verified against HEAD)

- `resolveNoBotOwnerMode` (subject-resolver.ts:146-158) for `actor.type === 'agent'` returns `ports.getDefaultOwnerMode?.(ownerId) ?? 'paper'`.
- `bin.ts`'s `resolverPorts` (bin.ts:227-241 area) define only `getBotById` + `listVenueAccountsByOwner` — **neither default port is wired**.
- Consequence 1 (mode): every agent-direct actor is constructed with `executionMode: injection.ownerMode = 'paper'` regardless of the agent's configured shadow/live mode. `checkModeEscalation`'s ceiling is therefore wrong for every non-paper agent — a live-entitled agent would be refused escalation to its real mode. Live enforcement today is mostly keyed off persisted config, so this is latent, not active — but it is a gate that will misfire the moment mode semantics matter (and it already mislabels `ctx.executionMode` in tool results).
- Consequence 2 (venue): `getDefaultVenueAccountId` unwired means multi-account owners rely entirely on the payload-supplied `venueAccountId` hint (herobids sends it — fixed in phase 1). Other consumers without the hint would hit "ambiguous". Operator knob missing.

## Approach

1. **Owner mode — DECIDED: option (a), static operator default.** Wire `getDefaultOwnerMode` in `bin.ts` to return the venue-appropriate configured default from traderton's own operator config (`config.execution` / live-rollout blocks in traderton `config/default.yaml`). Traderton has no agents table (locked), so the port cannot and must not read per-agent mode. Do NOT extend the payload to carry per-agent mode (that was option (b) — rejected: it overlaps B1 and would be throwaway once the trading profile owns mode). Keep the port honest to its docstring ("operator-configured default owner mode for the no-bot path").
2. **Venue default — DECIDED: oldest account by `created_at`.** Wire `getDefaultVenueAccountId` from traderton's `venue_accounts`: return the owner's oldest account (deterministic; `created_at` ascending, id tiebreak). First check `venue-accounts.ts` for an explicit default column — the verified schema has NONE, so use oldest-by-`created_at` with a code comment. Note a possible future `is_default` column as a follow-up in the PR description; do not add it now.
3. **Tests:** resolver unit tests for both ports (the port seams are fakeable — `subject-resolver.test.ts`); a boundary-level test asserting an agent-subject `submit_decision` constructs the actor with the wired default mode (not `paper`) for a shadow-configured setup.

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
