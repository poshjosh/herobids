# M1: Shared autoscaling core, tier-aware

**Status:** in_progress
**Program:** [README](../README.md) · [milestones](../milestones.md) · [conventions](../conventions.md)
**Started:** 2026-11-11 **Verified against:** `herobids` `ee532da6`, staging control plane

## Goal

The autoscaler's safety logic (ownership guard, plan checks, state and alert isolation) is driven by a **tier profile** instead of hard-coded agent names. The agent tier behaves exactly as before. Staging scale-out is no longer refused by the guard. A second tier, with differently named and keyed servers, can reuse the same checks.

Why this is first: staging autoscale-out is refused every minute today (`ownership_mismatch`, see [F1.1](./f1-1-tier-aware-guard/plan.md)), and every other tier (browser nodes, caps pool) hits the same guard.

## Exit checks (proposed; they freeze once the owner approves the program's location and organisation, owner-inbox item I-001)

1. **Staging is unblocked.** With the caps servers present, the staging autoscale log shows no `ownership_mismatch` for 10 consecutive timer runs, and no server is created or destroyed outside the bounds (max 3 agent nodes).
2. **Agent behaviour is byte-identical.** Golden outputs (reconcile snapshots, allowlist and plan-validate verdicts, resolved defaults) are unchanged for the agent profile. `tests/run-all.sh` and `check-nomad-capacity.test.sh` pass.
3. **The checks are profile-driven.** The reconcile, plan allowlist, scale-in plan validator, state/lock/cooldown paths and alert state take their identity from a tier profile.
4. **A second tier works in fixtures.** A for_each-style profile (role `browser`) passes the same checks: it does not collide with the agent tier's ownership guard, and it uses separate lock, cooldown, state and alert files.
5. **OD-01 is decided and recorded** (shared kit scope, language, repository timing) and M1's code is consistent with it.

## Scope

**In:** the ownership guard, plan allowlist, scale-in plan validator, state and alert isolation, tests and fixtures.
**Out (and where it goes):** the browser demand signal and node pool → M3; Traderton → M4; node sizing and the control plane → M2; a new repository or a TypeScript core → depends on OD-01.

## Design references

- [Autoscaler coupling analysis](./reference/autoscaler-coupling-analysis.md): what is generic, what is hard-coded, the seams, the risks, the test coverage.
- Decision brief [001 autoscaling architecture](../../../../../../decisions/briefs/001-autoscaling-architecture.md) (OD-01).
- [Plan 005](../../../../../pending/005-browser-pool-dedicated-tier/001-plan.md): the browser tier that will be the second consumer.

## Feature plans

| ID | Plan | Status | Notes |
|---|---|---|---|
| F1.1 | [Tier-aware ownership guard and caps-pool fix](./f1-1-tier-aware-guard/plan.md) | ready | First plan. No-regret under every OD-01 option except adopting a different autoscaler |
| F1.2 | Profile-driven plan allowlist and scale-in validation for for_each-keyed resources | planned | Draft when F1.1 reaches its last phase. Waits for OD-01 |
| F1.3 | Second-tier fixtures and isolation of lock, cooldown, state and alerts | planned | Draft after F1.2 |

## Decisions

| ID | Question | Status | Blocks |
|---|---|---|---|
| OD-15 | How should the guard treat the caps pool (`herobids-staging-agent-caps-N`)? | open; brief 003 to be written in F1.1 | F1.1 phase D |
| OD-01 | Shared kit: scope, language, repository timing | open; homework done; two facts needed from the owner (owner-inbox item I-002: Hetzner project sharing, engineering capacity) | F1.2, F1.3 |

## Risks

| Risk | How we would notice | What we do |
|---|---|---|
| The cause of the staging block is not the caps naming | F1.1 task A3 fails to reproduce it | Stop; diagnose from the log and the live inventory (read-only); do not change the guard until reproduced |
| Parameterising changes agent behaviour | Golden outputs or the suite differ | Revert the step; the change is split into byte-identical steps |
| Unblocking the guard lets staging scale out and cost money | The log shows a scale-out after deploy | Staging max is 3 nodes; confirm demand and bounds before deploy; the owner approves the deploy (inbox) |
| OD-01 picks "adopt another autoscaler", making F1.2 and F1.3 wasted | The decision record says so | F1.1 still fixes a real bug; F1.2 and F1.3 are not started until OD-01 is decided |

## Closing checklist

- [ ] Every exit check passed, with evidence linked here
- [ ] Registers in `docs/decisions/` updated (03, 04, 05)
- [ ] Journal entry written; `milestones.md` updated
