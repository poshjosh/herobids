# 002 — `deriveHasTradingCapability` throws on runtime resolved-skill shape, silently blocking session launch

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-10-06
- **Summary:** On branch `feat/repeating-reminders-mvp`, 4 tests in `apps/worker/src/agents/permission-level-wiring.test.ts` fail because `runtimeLauncher.launch` is never called (`Number of calls: 0`). The regression is a `TypeError` thrown inside `reconcileStartingSessions` that is swallowed by the launch `try/catch`.

## Root Cause

WP1 added a call in `apps/worker/src/agents/agent-session-manager.ts` `reconcileStartingSessions` (~line 526):

```ts
resolvedRuntimePolicy: resolveAgentRuntimePolicy(
  agent.style ?? null,
  agent.runtimePolicyOverrides ?? null,
  { hasTradingCapability: deriveHasTradingCapability(runtimeDescriptor.resolvedSkills) },
),
```

`deriveHasTradingCapability` (`apps/worker/src/agent-capabilities.ts`) did:

```ts
resolvedSkills.some((skill) => skill.capabilityFamilies.includes('trading'));
```

`RuntimeDescriptor.resolvedSkills` is typed via `SkillDefinition[]`, whose `capabilityFamilies` is a required `string[]`. But the real runtime value (and the `makeRuntimeDescriptor` fixture in `permission-level-wiring.test.ts`) is a **narrower runtime shape that omits `capabilityFamilies`**. The type lies at this boundary. When the field is `undefined`, `undefined.includes(...)` throws a `TypeError`.

That throw happens inside the `try` block of `reconcileStartingSessions`, whose `catch` logs the error and reverts the session — so `runtimeLauncher.launch` is never reached. The test passes on `main` (no such call existed) and fails on the branch (WP1 introduced the call) — a genuine regression.

`deriveTradingTickWorkPlan` calls the same predicate, so it was affected too; the single fix covers both.

## Fix

Made the predicate tolerant of a missing/non-array `capabilityFamilies` at runtime, keeping it strict-typed (no `any`, no behaviour change for skills that declare trading):

```ts
export function deriveHasTradingCapability(resolvedSkills: SkillDefinition[]): boolean {
  return resolvedSkills.some(
    (skill) => Array.isArray(skill.capabilityFamilies) && skill.capabilityFamilies.includes('trading'),
  );
}
```

Added a code comment documenting the type-vs-runtime boundary mismatch.

### Scope check — other direct `.capabilityFamilies.includes(...)` uses

`apps/worker/src/runtime-composition.ts:785` (`hasTradingCapability`) uses the same unguarded pattern, but it **predates this branch** (not a WP1 change) and is not on the failing path; left unchanged to keep the fix targeted. (The API path uses the id-based `hasSkillCapabilityFamily`, which is unaffected.)

## Files Changed

- `apps/worker/src/agent-capabilities.ts` — guarded the predicate with `Array.isArray`, added boundary comment.
- `apps/worker/src/agent-capabilities.test.ts` — added two regression tests: returns `false` (not throw) when a resolved skill omits `capabilityFamilies`; still returns `true` when a trading skill is present alongside one lacking the field.

## Verification

- `pnpm --filter @herobids/worker exec vitest run src/agent-capabilities.test.ts src/agents/permission-level-wiring.test.ts` → 24 passed (both suites green; the 4 previously-failing permission-level tests now pass).
- `pnpm lint` (`tsc --noEmit`) → clean.
