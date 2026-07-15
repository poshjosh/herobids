# Final MVP Validation And Release Evidence

**Inputs:**

1. [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md)
2. [011-phase-3-swap-live-safety-parity.md](./011-phase-3-swap-live-safety-parity.md)
3. [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md)
4. [013-1inch-launch-safety.md](./013-1inch-launch-safety.md)
5. [014-phase-4-agent-risk-contract-integrity.md](./014-phase-4-agent-risk-contract-integrity.md)
6. [2026-06-15-validation-summary.md](../../../../test-reports/e2e-report/2026-06-15-validation-summary.md) (output artifact — created by Stage 6, not a precondition)

## Purpose

Define the final validation sequence and evidence bundle required before OpenAIdom can be called MVP production-ready.

This document is intentionally cross-cutting. The earlier plan documents describe what must be built or fixed. This document describes how to prove, at the end, that the remaining launch blockers are actually closed.

## Why This Needs Its Own Doc

The repo already has:

1. feature and implementation plans
2. a verified launch checklist
3. test and UAT summaries
4. smoke scripts and test harnesses

What it does not yet have is one final release procedure that answers all of the following in one place:

1. which open launch blockers must be complete
2. which commands must pass
3. which non-CI validations must be run
4. which artifacts count as release evidence
5. what explicitly blocks a release even if the happy path seems fine

Without this document, the likely failure mode is local optimism: several good results exist, but no single release-ready proof package exists.

## Release Boundary

Per the verified checklist, MVP production readiness is blocked only by these four surfaces:

1. swap pending-confirmation recovery and restart safety
2. Jupiter swap trading launch safety
3. 1inch swap trading launch safety
4. risk contract integrity

This plan assumes deferred items remain deferred and are not reintroduced as hidden blockers.

## Preconditions

Do not begin the final release-evidence run until all of the following are true:

1. [011-phase-3-swap-live-safety-parity.md](./011-phase-3-swap-live-safety-parity.md) is implemented and its acceptance criteria are met
2. [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md) is implemented and its acceptance criteria are met
3. [013-1inch-launch-safety.md](./013-1inch-launch-safety.md) is implemented and its acceptance criteria are met
4. [014-phase-4-agent-risk-contract-integrity.md](./014-phase-4-agent-risk-contract-integrity.md) is implemented and its acceptance criteria are met
5. [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) can be updated so every `Launch Gate = yes` row is `complete`

If any one of those is still incomplete, this doc is not yet executable as a go/no-go release gate.

## Evidence Principles

The release decision must be backed by evidence that is:

1. executable where possible
2. current to the release candidate, not stale from older commits
3. tied to the actual launch blockers, not only generic repo health
4. strong enough to disprove known failure modes, not just confirm happy paths

For Stage 4 specifically, the expected truth source is one canonical operator-run validation command per swap venue. A manual checklist is still required, but only as the runbook that explains prerequisites, expected outputs, and evidence capture for that command.

## Required Evidence Bundle

The release bundle should contain all of the following:

1. updated verified checklist showing all launch-gate rows as `complete`
2. repo-level validation results for build, lint, and test tiers
3. focused test results for swap parity, Jupiter, 1inch, and risk contract integrity
4. non-CI venue validation results for Jupiter and 1inch
5. one operator-readable release summary that states pass/fail for each launch blocker
6. any bug reports created during the validation pass, with explicit decision whether each blocks release
7. the exact operator commands and companion checklists used for Jupiter and 1inch validation

## Validation Stages

Run the final validation in stages. Do not skip ahead when an earlier stage fails.

### Stage 1: Repo Health Baseline

**Goal:** prove the release candidate is not already broken at the repository level.

Required commands:

1. `pnpm build`
2. `pnpm lint`
3. `scripts/shell/tests/run-all-tests.sh`

Acceptable outcome:

1. build passes
2. lint passes
3. automated test tiers pass, or any known failures are explicitly documented as pre-existing and non-blocking to the production MVP claim

If this stage fails unexpectedly, stop. Do not continue to venue-specific release claims.

### Stage 2: Focused Launch-Blocker Test Pass

**Goal:** prove the four remaining launch blockers are covered by focused tests, not only broad suite health.

Required focus areas:

1. swap restart recovery and ambiguity handling
2. Jupiter adapter and live-wiring proof
3. 1inch approval/reset-approval and transaction-truth proof
4. risk contract source, mutability, ceiling, reset, and restart behavior

Expected evidence:

1. targeted test runs or targeted test excerpts tied to `011`, `012`, `013`, and `014`
2. pass/fail summary for each focused plan

This stage exists because a green full-suite result can still hide weak launch-gate proof.

### Stage 3: Worker And Runtime Smoke Proof

**Goal:** prove the live worker path, actor startup, and safety gating still behave correctly in an integrated environment.

Expected checks:

1. canonical agent trade pipeline smoke using the existing `agent-trade-test` path where applicable
2. actor startup with swap binding metadata present
3. live-gate or runtime rejection when required signer or credential prerequisites are absent
4. journaling and persisted evidence for pending or completed swap work

Primary assets:

1. `scripts/ts/agent-trade-test.ts`
2. relevant worker integration and actor tests

This stage is still mostly controlled-environment proof, not final venue release evidence.

### Stage 4: Non-CI Venue Validation

**Goal:** produce real operator-run evidence for the two swap venues that cannot safely depend on permanent CI secrets.

Decision for this stage:

1. each swap venue must have one canonical operator-run validation command
2. each command must have a short companion checklist documenting prerequisites, expected observations, and required evidence artifacts
3. checklist-only validation is not sufficient as the primary release truth source when a repeatable command can be provided

#### Stage 4A: Jupiter

Run the Jupiter launch validation defined by [012-jupiter-launch-safety.md](./012-jupiter-launch-safety.md).

Required input shape:

1. one canonical Jupiter validation command or script invocation
2. one companion checklist/run note for operator use

Required proof:

1. quote succeeds
2. signing prerequisite is enforced
3. signed swap submission succeeds on the intended environment
4. confirmation evidence is observed
5. persisted execution evidence is present and understandable

#### Stage 4B: 1inch

Run the 1inch launch validation defined by [013-1inch-launch-safety.md](./013-1inch-launch-safety.md).

Required input shape:

1. one canonical 1inch validation command or script invocation
2. one companion checklist/run note for operator use

Required proof:

1. quote succeeds
2. approval behavior is correct for the chosen wallet state
3. swap submission succeeds on the intended environment
4. transaction evidence is interpretable through the configured router-scoped logic, with `routerAddress` configured for the launch environment
5. persisted execution evidence is present and understandable

These are release blockers. If either venue lacks current real-world proof, the MVP production claim is not yet justified.

#### Partial-Launch Decision Rule

If one swap venue passes Stage 4 but the other fails:

1. the passing venue may be marked `complete` in the checklist
2. the failing venue remains `incomplete` and blocks a full MVP release claim
3. a partial launch (perps + passing swap venue only) is acceptable if the operator explicitly chooses to defer the failing venue
4. in that case, the release summary must state which venue is deferred and why
5. the deferred venue does not need to block other production traffic, but its checklist row stays `incomplete` until its own Stage 4 passes

### Stage 5: Risk Contract Validation

**Goal:** prove the agent risk contract works as specified, not merely as a flat set of numeric limits.

Required proof:

1. creator-configured limits remain immutable
2. default-derived limits are visible to the agent
3. default-derived limits are adjustable only within operator ceilings
4. overrides persist separately from creator config and survive restart
5. worker enforcement uses resolved effective values consistently

Primary source:

1. [014-phase-4-agent-risk-contract-integrity.md](./014-phase-4-agent-risk-contract-integrity.md)

This is a launch blocker even if swap safety passes.

### Stage 6: Checklist Reconciliation And Go/No-Go

**Goal:** update the launch checklist from evidence, not belief, and make the release call.

Required actions:

1. update [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) using current evidence only
2. confirm every `Launch Gate = yes` row is `complete`
3. confirm no newly discovered high-severity defect contradicts the checklist
4. produce a short release summary stating either:
   - MVP production-ready
   - not ready, with exact blocking rows

## Failure Modes That Still Block Release

Even if broad tests pass, release is blocked if any of the following remain unresolved:

1. a submitted live swap can disappear or become unrecoverable across restart
2. ambiguous swap confirmation state can still trigger blind resubmission
3. Jupiter live path lacks direct venue-specific proof at the adapter and execution boundary
4. 1inch approval or reset-approval behavior remains weakly proven or contradictory
5. the agent risk contract still collapses immutable and mutable limits into one undifferentiated runtime model
6. non-CI venue validation cannot be reproduced or produces inconsistent results
7. the checklist says `complete` for a launch-gate item but the evidence still contains caveats that materially weaken the claim
8. 1inch launch evidence depends on transaction interpretation without configured `routerAddress`

## Required Artifacts

At the end of the release-evidence run, capture or update these artifacts:

1. one release summary document for the final run
2. updated checklist document
3. command results or summarized outputs for build/lint/tests
4. operator-run venue validation notes for Jupiter and 1inch
5. any new bug reports created during final validation
6. the exact canonical venue commands used during Stage 4

The release summary should be short and decision-oriented, not a raw transcript.

## Exit Rule

OpenAIdom is MVP production-ready only when all of the following are true:

1. every launch-gate row in [production-core-cut-checklist.md](../../15/production-core-cut-checklist.md) is `complete`
2. repo-level validation is green enough to support a release claim
3. Jupiter and 1inch each have current venue-specific launch evidence
4. the risk contract implementation matches the documented two-path model
5. no unresolved high-severity safety defect contradicts the release claim

If any one of those is false, the correct release decision is `not ready`.