# Consume Traderton over REST (L3) — START HERE

**A fresh session lands here with no context. This folder is self-contained; read it in order.**

## What's happening
Trading is being extracted into a separate **Traderton** service. herobids is becoming its
**REST consumer**: it deletes its in-tree trading execution and calls Traderton's boundary
(HMAC-signed `POST /internal/v1/tools:invoke`) instead. Everything else (agents, messaging,
LLM, the connection/grant layer, approvals, maxBots) stays in herobids.

## Where you may work
**Branch `consume-traderton` ONLY.** herobids `main` and every other branch are untouchable.
Merging this branch to `main` = **cutover**, and needs explicit human approval. Never touch the
stray `apps/worker/src/watch-summary.js`.

## Read in order
1. `000-l3-consumption-spec.md` — the working spec: the DELETE/KEEP/REWIRE seam, decisions
   D1–D5, and the sub-phasing (L3a → L3b → L3c → L3d → L3e).
2. `001-l3a-implementer-prompt.md` — the current task (**L3a**): the Traderton REST client +
   config + HMAC signer. No rewire, no deletion yet.

## Where the authority lives (until cutover)
State, decisions, and invariants are the source of truth in the sibling **Traderton** repo,
not here: `traderton/docs/CANONICAL-STATE.md` (and the 005 contract it points to). This folder
is the herobids-side *working* record and defers to CANONICAL-STATE. At cutover the
repo-of-record moves to herobids (a working-location change — Traderton is NOT absorbed).

## Progress
- [x] Spec + L3a prompt written.
- [ ] L3a — REST client + config + signer.  ← **next**
- [ ] L3b reads → L3c writes → L3d delete trading packages → L3e differential + staging + merge gate.
