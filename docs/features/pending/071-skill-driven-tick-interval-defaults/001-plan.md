# Skill-Driven Tick Interval Defaults

## Summary

Replace the hardcoded `tickIntervalMins` values in `AGENT_STYLE_RUNTIME_DEFAULTS` with a computation that derives the default tick interval from the agent's selected skills. Each skill carries a `suggestedTickIntervalMs`; the average across selected skills (excluding `base`) becomes the **baseline**, which is then modulated by the agent's style (careful/balanced/bold). The existing hardcoded style values serve as a fallback.

This is a companion to `070-agent-min-tick-interval-extension` — together they give agents the right base cadence and the ability to extend it when idle.

## Motivation

### Current problem

`AGENT_STYLE_RUNTIME_DEFAULTS` and the frontend `STYLE_CONFIG` define tick intervals that are trading-centric:

| Style | Tick Interval | Design Intent |
|---|---|---|
| Careful | 90 min | Low-frequency trading |
| Balanced | 30 min | Moderate trading |
| Bold | 10 min | Active trading |

A personal-assistant agent (skills: `task-management`, `web-access`, `email`) assigned the "careful" style still ticks every 90 minutes — 16 scout LLM calls per day, almost all of which result in "hold" because there's nothing to do. This is wasteful.

Non-trading agents should default to much longer intervals (hours, not minutes) and rely on wake signals (reminders, user messages) for timely action.

### Why skill-driven?

Skills already encode domain knowledge about appropriate cadences via `suggestedTickIntervalMs`. Using these values:

1. **Composable** — the default naturally adapts to the agent's skill set
2. **Backward compatible** — trading-only agents get the same defaults as today
3. **No new user-facing concept** — users still see "Tick interval" in the UI; the default is just smarter
4. **Self-documenting** — updating a skill's suggested interval updates the default for all agents using that skill

## Design

### Formula

```
defaultTickIntervalMs = styleMultiplier × baselineMs

where:
  baselineMs = avg( skill.suggestedTickIntervalMs for each skill, excluding 'base' )

  styleMultiplier:
    careful → 3.0
    balanced → 1.0
    bold → 0.33 (1/3)
```

### Fallback chain

If no baseline can be computed from skills, fall back in order:

1. **Skill-driven baseline** — average of selected skills' `suggestedTickIntervalMs` (excluding `base`)
2. **Preset-aware fallback** — if the agent was created from a known preset (`trading`, `personal-assistant`, etc.), use a preset-specific default
3. **Style-aware hardcoded fallback** — the current `tickIntervalMins` values in `AGENT_STYLE_RUNTIME_DEFAULTS` / `STYLE_CONFIG`
4. **Platform default** — 15 minutes (absolute last resort)

### Updated `suggestedTickIntervalMs` values

All values in minutes (ms for storage):

| Skill | Current | Proposed | Reasoning |
|---|---|---|---|
| `trading` | 5 min (300,000) | **30 min** (1,800,000) | Reasonable monitoring cadence; aligns with balanced style |
| `risk-monitoring` | 5 min (300,000) | **30 min** (1,800,000) | Aligned with trading |
| `programming` | 15 min (900,000) | **30 min** (1,800,000) | Code execution is active work, warrants more frequent ticks |
| `email` | 5 min (300,000) | **60 min** (3,600,000) | Not real-time; email is inherently async |
| `task-management` | 15 min (900,000) | **60 min** (3,600,000) | Reminder-driven, not polling-based |
| `web-access` | 15 min (900,000) | **60 min** (3,600,000) | Research is deliberate, not continuous |
| `file-management` | 15 min (900,000) | **60 min** (3,600,000) | File ops are event-driven |

The `base` skill and `bot-management` skill are excluded from computation:
- `base` is auto-injected and doesn't represent an agent capability choice
- `bot-management` inherits cadence from the overall agent, not dictating it separately

### Worked examples

| Preset | Skills | Baseline | × Careful (3.0) | × Balanced (1.0) | × Bold (0.33) |
|---|---|---|---|---|---|
| `trading` | trading (30), bot-mgmt (–) | 30 min | **90 min** | **30 min** | **10 min** |
| `personal-assistant` | task-mgmt (60), web (60), email (60) | 60 min | **180 min** | **60 min** | **20 min** |
| `direct-trading` | trading (30) | 30 min | 90 min | 30 min | 10 min |
| `custom` (trading + task-mgmt) | trading (30), task-mgmt (60) | 45 min | 135 min | 45 min | 15 min |

The `trading` and `direct-trading` presets produce **identical values** to the current hardcoded defaults (90/30/10) — zero behavior change for existing trading agents.

### Clamping

Computed values are clamped to `[1 minute, 24 hours]` to prevent absurd results at extreme baselines or multiplier edges.

## Detailed Plan

### 1. Update skill `suggestedTickIntervalMs` values

File: `packages/domain/src/skills.ts`

- Update `suggestedTickIntervalMs` on each skill to the proposed values above
- Verify no downstream test assertions hardcode the old values

### 2. Add `computeDefaultTickIntervalMs()` to domain config

Files:
- `packages/domain/src/config/tick-interval.ts` (new file)
- `packages/domain/src/config/tick-interval.test.ts` (new file)

The function:

```typescript
export function computeDefaultTickIntervalMs(params: {
  skillIds: string[];
  style: AgentStyleValue;
  presetId?: string | null;
}): number
```

Implementation details:

- Look up each `skillId` in `SYSTEM_SKILLS`, skip `base` and `bot-management`
- Compute average of `suggestedTickIntervalMs` across matched skills
- If no skills remain after filtering, apply the fallback chain
- Multiply by style multiplier
- Clamp to `[60_000, 86_400_000]` (1 min to 24 hours)
- Round to nearest millisecond

Preset-aware fallback mapping (step 2 in the chain):

```typescript
const PRESET_FALLBACK_TICK_INTERVAL_MS: Record<string, number> = {
  'trading':            30 * 60_000,
  'direct-trading':     30 * 60_000,
  'trading-assistant':  30 * 60_000,
  'personal-assistant': 60 * 60_000,
};
```

Style-aware fallback (step 3) reads from `AGENT_STYLE_RUNTIME_DEFAULTS[style].tickIntervalMins`.

**Note on `presetId`**: The `skillPresetId` is a frontend concept not persisted on the agent record. For this feature, the API should accept an optional `skillPresetId` hint on create (informational only, not stored) to enable preset-aware fallback. If not provided, the function skips step 2.

### 3. Wire into API create agent flow

Files:
- `apps/api/src/routes/agents.ts`

Changes:

- Extend `CreateAgentSchema` with an optional `skillPresetId` field (string, optional, not persisted)
- After parsing the create request, if `tickIntervalMs` was not explicitly provided by the user, compute the default:
  ```typescript
  if (parsed.data.tickIntervalMs === undefined) {
    parsed.data.tickIntervalMs = computeDefaultTickIntervalMs({
      skillIds: parsed.data.skillIds ?? [],
      style: parsed.data.style ?? 'balanced',
      presetId: parsed.data.skillPresetId ?? null,
    });
  }
  ```
- The computed value is stored in `tickIntervalMs` on the agent record — it becomes an explicit stored value, not a derived one
- On PATCH, if the user explicitly sets `tickIntervalMs`, that value is used. If they don't touch it, the existing stored value is preserved (no recomputation)

Rationale for compute-at-create-time: simpler than runtime derivation, the value is explicit and auditable in the database, and the user can always override it. Skill definition changes are rare and operators can document that agent recreation may be needed to pick up new defaults.

### 4. Update style defaults documentation

Files:
- `packages/domain/src/config/schema.ts` — `AGENT_STYLE_RUNTIME_DEFAULTS`
- `apps/web/src/features/agents/style-mapping.ts` — `STYLE_CONFIG`

Changes:

- Add a comment above `tickIntervalMins` in both files noting that these values are now **fallbacks only** — the primary default is computed from skills via `computeDefaultTickIntervalMs()`
- Do NOT remove the values — they remain as fallback step 3 and for backward compatibility
- Update `maxHoldDurationMs` comments since they reference "× tick interval" — note that the multiplier now applies to the skill-derived baseline, not the style fallback

### 5. Frontend: show computed default in create form

Files:
- `apps/web/src/features/agents/AgentFormBody.tsx`
- `apps/web/src/features/agents/agent-form-state.ts`
- `apps/web/src/features/agents/agent-payloads.ts`

Changes:

- When the user selects a skill preset or individual skills, compute the expected default tick interval client-side (mirroring `computeDefaultTickIntervalMs` logic) and display it as a helper text or placeholder in the Tick interval field
- Example: *"Default: 60 min (based on your selected skills)"*
- The field remains editable — the computed value is a suggestion, not a lock
- Send `skillPresetId` to the API on create so the server-side computation can use preset-aware fallback

Recommendation: extract the computation into a shared utility (e.g., `packages/domain/src/config/tick-interval.ts`) that both API and frontend can import, avoiding duplication.

### 6. Testing plan

#### Domain / config

- `computeDefaultTickIntervalMs` returns expected values for each preset
- Empty skill list falls back to preset-aware default
- Empty skill list with no preset falls back to style hardcoded default
- Unknown preset falls back to style hardcoded default
- Multi-skill agents produce correct averages
- Clamping: values below 1 min are raised, values above 24h are lowered
- `bot-management` and `base` are excluded from computation
- Rounding produces integer milliseconds

#### API

- Create agent without explicit `tickIntervalMs` → stored value equals computed default
- Create agent with explicit `tickIntervalMs` → explicit value is used (not overridden)
- Create agent with `skillPresetId: 'personal-assistant'` and style `balanced` → stored `tickIntervalMs` = 60 min
- PATCH agent without touching `tickIntervalMs` → value preserved (no recomputation)
- PATCH agent setting `tickIntervalMs` explicitly → new value stored

#### Web

- Skill preset selector updates the displayed computed default
- Individual skill toggles update the displayed computed default
- Explicitly typed tick interval overrides the computed suggestion
- Helper text renders correctly for each preset/style combination
- i18n strings render in create/edit forms

### 7. Documentation

Files:
- `docs/tech/agents/runtime-policy-and-reasoning.md` — document the new default computation
- `docs/tech/domain-language.md` — add `suggestedTickIntervalMs` to the glossary if not present

## Suggested Implementation Order

1. Update `suggestedTickIntervalMs` values in `packages/domain/src/skills.ts`
2. Create `computeDefaultTickIntervalMs()` + unit tests in `packages/domain/src/config/`
3. Wire into API create flow in `apps/api/src/routes/agents.ts`
4. Update frontend to show computed default in create form
5. Update style defaults comments/documentation
6. Update documentation files
7. Run `pnpm lint` and full test suite

## Risks and Guardrails

- **Risk**: Skill definition updates change defaults for existing agents silently.
  - **Mitigation**: Default is computed once at create time and stored explicitly. Updating a skill's `suggestedTickIntervalMs` does not retroactively change existing agents.

- **Risk**: Average-based computation produces a poor default for mixed trading/non-trading agents.
  - **Mitigation**: In practice, presets keep skill sets cohesive. The user can always override. If this becomes a real problem, we can switch to `min()` or add a spread-detection guardrail in v2.

- **Risk**: The 3× multiplier produces extreme values at long baselines (e.g., 60 min × 3 = 180 min = 3h for careful personal-assistant).
  - **Mitigation**: 3 hours is intentional and cost-efficient for non-trading agents. The 24h clamp prevents truly absurd values. Wakes still preempt the timer.

- **Risk**: `skillPresetId` in the API create payload is not persisted, creating drift between what the frontend sent and what the backend stored.
  - **Mitigation**: `skillPresetId` is only used for fallback computation at create time. The stored `tickIntervalMs` is explicit and auditable. If the preset-aware fallback was used, the stored value reflects it.

## Non-Goals For V1

- No runtime re-derivation of tick interval from skills
- No migration of existing agents to new defaults
- No change to how `tickIntervalMs` is stored (remains a direct column, not part of `runtimePolicyOverrides`)
- No new `personal-assistant` style in `AgentStyleSchema` (the enum remains `careful | balanced | bold`)
- No per-skill tick interval visibility in the agent runtime prompt

## Open Decisions

1. **Average vs. minimum for multi-skill baseline?**
   - Recommendation: average for v1. Presets keep skill sets cohesive. Revisit if users create mixed trading/non-trading agents.

2. **Should `bot-management` have its own `suggestedTickIntervalMs`?**
   - Recommendation: no for v1. It inherits from the overall agent cadence. `bot-management` is always paired with `trading`.

3. **Should the `skillPresetId` be persisted on the agent record?**
   - Recommendation: no for v1. It's only needed at create time for fallback computation. The stored `tickIntervalMs` is the source of truth.

4. **Should the multiplier be configurable per operator?**
   - Recommendation: no for v1. 3× is simple and produces sensible results across all current skill baselines.

5. **What should the platform default (step 4 fallback) be?**
   - Recommendation: 15 minutes. Matches the current `base` skill's `suggestedTickIntervalMs` and is a reasonable generic default.

6. **Should the frontend compute the default client-side or fetch it from the API?**
   - Recommendation: client-side (mirror the domain function). Avoids an extra API call and enables instant UI updates when skills change. The domain function should be importable by both API and web.
