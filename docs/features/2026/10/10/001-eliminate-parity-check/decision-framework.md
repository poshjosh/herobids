# Decision framework for in-milestone decisions

Most decisions an executing agent hits are small implementation details inside an
already-ratified direction. Those are **yours to make, immediately, with no brief**. A
small number are not; those go to a human through a short brief. This page says which is
which. Read it once before starting a milestone; consult the checklist whenever you are
about to pick between two options.

The "who is the human": the project owner who ratified
[B-parity-ownership.md](decisions/B-parity-ownership.md). Record escalations in the
[ledger](EXECUTION_LEDGER.md); do not rely on remembering them.

## 1. Default: the lightweight path

**When:** the choice is an implementation detail inside a direction that Brief B, the
mechanics doc, an ADR, or the milestone row already settled.

**How to decide, in this order of authority:**

1. The milestone row's stated decisions and the rules in Brief B
   ([Mechanical rules](decisions/B-parity-ownership.md#mechanical-rules-for-executing-agents)).
2. [AGENTS.md](../../../../../../AGENTS.md) conventions (naming, `Result`, strict types,
   config layering, `.example` twins).
3. Existing precedent: find how this codebase already does the equivalent thing
   (an error-code pattern, a helper, a test layout) and match it.
4. The simplest thing that satisfies the done-state (KISS; do not add abstractions or
   options the row does not ask for).

**Convert heavy-looking questions into evidence first.** Before escalating, try to settle
the question by looking: a grep for real call sites, reading the actual schema, running
the checker, **and running the owning repo's suite with the change applied**. In this
epic, the eight `domain-ports-*` mirrors stopped being an ownership question once a grep
of herobids found zero consumers *and* a trial deletion passed every herobids check
(`investigation-findings.md`, Group 2; roadmap verification table). The counter-example
is the traderton preset YAML: a grep "found zero references", the files were deleted,
and 14 traderton tests failed, so the claim was retracted. A grep that looks conclusive
but was not closed out by the suite is not yet lightweight evidence. If a grep or a
file read settles it *and* the suite agrees, it was lightweight.

**Record:** one line in the commit message (`Decision: ...`) and, if it affects later
milestones, in the milestone's ledger notes. No separate document.

**Examples from this epic (all lightweight):**

| Question | How it is settled |
|---|---|
| Which existing union should `approval-service.ts` use instead of the deleted `ActorType`? | Brief B names two equivalents (`ActorTypeSchema`, `ExternalBackendActorType`); pick whichever the file's neighbours already import. |
| What do I name the local 7-field economic-event view type? | Match nearby naming in `runtime-composition.ts`. |
| Where to put `venueTypeFromProvider` once `execution-capability.ts` goes? | Next to `SWAP_VENUES` / `ORDERBOOK_VENUES` in herobids's config module it already depends on. |
| Region markers for narrowing the `domain-ports-candle-fetcher` entry? | Start at `export interface PriceCandle`, end at `export interface CandleFetcher`; verify the checker passes. |
| Is this file really dead? | Run the I6 grep **and** the trial deletion judged by the owning repo's full suite. Grep alone is not evidence enough. |
| Do I delete a stale test for a deleted file? | Yes; a test that only tested the deleted code goes with it. |

## 2. The exception: the heavyweight path

Stop and write a brief if **any** of these is true. The list is derived from what actually
needed ratification in Brief B and what did not.

- [ ] **H1. Contradicts a ratified decision or ADR**, or the premise of one. (Example, open
  now: Brief B decision 2 says traderton "was already the authoritative check", but no
  traderton equivalent exists for the agent path at `routes/agents.ts:1276`, milestone
  B1.2.)
- [ ] **H2. Irreversible or hard to reverse *decision***: dropping data, deleting something
  that may have a consumer you cannot see, or choosing something that cannot be undone.
  (Carrying out a release, tag or publish that a milestone already calls for is **not**
  heavyweight; invariant I12 covers it.)
- [ ] **H3. Changes scope**: a new disposition category (disposition (6) needed
  ratification), moving a feature to the other repo, a new cross-repo dependency, adding
  or removing a milestone's reason to exist.
- [ ] **H4. Removes a documented safety behavior or an enforcement check**, even a
  duplicated one (execution-capability / mode-rank pre-checks needed ratification for
  this reason).
- [ ] **H5. Affects something with no clear product owner**, or that might have an
  external consumer (`actor-health` routes needed ratification and still needs a human
  confirmation before deletion).
- [ ] **H6. Unverifiable from the repo and public docs**: it depends on an external fact
  (registry permissions, what the original author intended, behavior of a deployed
  service). If checking is a grep or a file read, it is lightweight; if it needs a person
  or a system you cannot reach, it is heavy. (The wire-DTO mechanism needed ratification
  partly because the real `DescriptorToolSchema` had to be checked for `outputSchema`.)
- [ ] **H7. Introduces a new architectural pattern** or shared abstraction not already in
  the repo or ratified (for example a package layout beyond what
  `wire-dto-package-mechanics.md` decided).
- [ ] **H8. Would change the wording or meaning of a ratified rule.** Clarifying an
  ambiguity is allowed only as a labeled clarification (see Brief B's clarifications
  section); changing a position is not.

If none apply, it is lightweight: decide and move on.

### What to do on the heavyweight path

1. **Stop that milestone**, not the epic. Mark it `blocked` in the ledger with a link to
   the brief, and pick another ready milestone (the roadmap's "Ready now" list).
2. **Write a short brief** at `decisions/<milestone-id>-<slug>.md`, in the same format as
   [B-parity-ownership.md](decisions/B-parity-ownership.md):
   - **Question** and **Status** (`PROPOSED`),
   - **Evidence** (file:line, grep results, the commands you ran),
   - **Options**, each with its cost and reversibility,
   - **Recommendation** and why,
   - **What this blocks** (milestone IDs).
3. **Flag it explicitly to the human** in your final message for the session. Do not
   decide and proceed silently, and do not edit ratified documents beyond adding a pointer
   to your brief.
4. After the human ratifies, record `Decision (<date>): ...` in the brief, update the
   roadmap rows it changes, and move the ledger row back to `ready`.

### Not a decision: a discovered gap

If you find a gap the roadmap did not account for (a new dependency, an unexpected
consumer), that is not automatically heavy. Apply
[invariants-and-quality-gates.md, section 3.3](invariants-and-quality-gates.md#33-when-a-milestone-is-not-done):
record it, resolve it in place if small, otherwise split it into a new row. It becomes a
heavyweight decision only if resolving it hits a checklist item above.

## 3. Worked examples from this epic's history

Source: [decisions/session-transcript.md](decisions/session-transcript.md) and
`investigation-findings.md`.

| Situation | Path | Why |
|---|---|---|
| "Does traderton really need herobids's preset YAML?" | **Lightweight evidence that failed**, now retracted | A grep found zero references, but deleting the files broke 14 traderton tests (`presets-loader` is called from `tools/trading-profiles.ts`). Lesson: close out every "dead" claim with the owning repo's suite (I6). |
| "Do `domain-ports-*` need a shared package?" | Lightweight, settled by evidence | Zero herobids consumers, **and** a trial deletion passed herobids's build, type checks and full suite (2026-10-10). |
| "Is a new 'retire the obligation' disposition acceptable?" | **Heavy** (H3, H7) | New category in the ratified taxonomy; needed ratification, now Brief B decision 1. |
| "Drop herobids's local execution-capability / mode-rank pre-checks" | **Heavy** (H4, H1 for one site) | Removes an enforcement path; ratified with an explicit tradeoff. |
| "Remove the actor-health routes" | **Heavy** (H5) | No identified product owner; ratified, but a human confirmation is still required before deletion. |
| "Package vs codegen vs runtime discovery for wire DTOs" | **Heavy** (H3, H6, H7) | New cross-repo dependency; hinged on an external fact (descriptor carries no `outputSchema`). |
| "Registry, version pin, CI dual-checkout" | **Heavy** (H2, H6) | Publishing and credentials; ratified in `wire-dto-package-mechanics.md`. |
