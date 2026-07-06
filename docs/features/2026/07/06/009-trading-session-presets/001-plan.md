# Trading Session Presets

Add named trading-session shortcut checkboxes (Asia, London, New York sub-windows) to
the agent form's "Allowed active hours" control. Sessions are only shown for trading
agents, are stored as semantic names (`tradingSessions`) so that DST is resolved
correctly at runtime, and drive a read-only UTC-hour preview in the existing hour grid.

---

## Background

The current `allowedHoursUtc` field lets users pick any UTC hours 0–23 via a checkbox
grid, but requires knowledge of UTC offsets. Users think in market-session terms
(Asia open, London open, New York). The requested sessions are expressed in Eastern
time (EDT = UTC-4 in summer, EST = UTC-5 in winter):

| Session | Local (Eastern) | UTC (EDT / summer) | UTC (EST / winter) |
|---|---|---|---|
| Asia | 8 pm – 12 am | 0, 1, 2, 3 | 1, 2, 3, 4 |
| London | 1 am – 5 am | 5, 6, 7, 8 | 6, 7, 8, 9 |
| NY Morning | 7 am – 10 am | 11, 12, 13 | 12, 13, 14 |
| NY Mid | 10 am – 12 pm | 14, 15 | 15, 16 |
| NY Afternoon | 12 pm – 4 pm | 16, 17, 18, 19 | 17, 18, 19, 20 |

## Design Decisions

### Option B: store session names, resolve to UTC at runtime
`tradingSessions` is a new optional field in `AgentRuntimePolicyOverrides` (stored in
the existing JSONB column — no migration). The worker resolves session names to UTC
hours at each tick using `Intl.DateTimeFormat('America/New_York')` so DST transitions
are handled automatically.

### Mutual exclusivity with `allowedHoursUtc`
`tradingSessions` and `allowedHoursUtc` are mutually exclusive:
- When any session preset is checked → `tradingSessions` is set; `allowedHoursUtc`
  override is cleared.
- When all session presets are unchecked → `tradingSessions` is cleared; `allowedHoursUtc`
  grid becomes editable again.

### Hour grid becomes a read-only preview when sessions are active
The existing 24-hour grid still renders but switches to a non-interactive mode that
highlights the UTC hours the selected sessions resolve to at the **current moment**
(using the browser's `Intl` API to determine the Eastern offset). This satisfies the
requirement that "the numbers 0–23 corresponding to the selections should be selected"
while making clear the hours will shift seasonally.

### Trading-skill gate
Session preset checkboxes are only rendered when `showTradingSessionPresets` is true
(threaded from `showTradingControls` in both `AgentsPage` and `EditAgentModal`).
`weekendPause` and the hour grid remain visible for all agents.

---

## Step 1 — Domain: add `tradingSessions` to policy types

**Status:** DONE

**Files:**
- `packages/domain/src/config/schema.ts`

### Changes

1. **Add `TradingSessionName` literal union above `AgentRuntimePolicyOverridesSchema`:**
   ```typescript
   export const TRADING_SESSION_NAMES = [
     'asia',
     'london',
     'ny-morning',
     'ny-mid',
     'ny-afternoon',
   ] as const;
   export type TradingSessionName = typeof TRADING_SESSION_NAMES[number];
   export const TradingSessionNameSchema = z.enum(TRADING_SESSION_NAMES);
   ```

2. **Extend `AgentRuntimePolicyOverridesSchema`** — add one field:
   ```typescript
   tradingSessions: z.array(TradingSessionNameSchema).nullable().optional(),
   ```

3. **Extend `ResolvedAgentRuntimePolicy` interface** — add one field:
   ```typescript
   tradingSessions?: TradingSessionName[] | null;
   ```

4. **Update `resolveAgentRuntimePolicy`** — pass through `tradingSessions`:
   ```typescript
   tradingSessions: o.tradingSessions ?? null,
   ```

### Checklist
- [ ] `TRADING_SESSION_NAMES`, `TradingSessionName`, `TradingSessionNameSchema` exported
- [ ] `AgentRuntimePolicyOverridesSchema` accepts `tradingSessions`
- [ ] `ResolvedAgentRuntimePolicy.tradingSessions` added
- [ ] `resolveAgentRuntimePolicy` passes through `tradingSessions`
- [ ] `pnpm lint` passes (packages/domain)

---

## Step 2 — Worker: DST-aware session resolution in `isWithinTradingHours`

**Status:** DONE

**Files:**
- `apps/worker/src/tick-gates.ts`

### Changes

1. **Extend `TradingHoursConfig`** — add one field:
   ```typescript
   tradingSessions?: TradingSessionName[];
   ```
   Import `TradingSessionName` from `@herobids/domain`.

2. **Add helper `getNyUtcOffsetHours(now: Date): 4 | 5`:**
   ```typescript
   function getNyUtcOffsetHours(now: Date): 4 | 5 {
     const parts = new Intl.DateTimeFormat('en-US', {
       timeZone: 'America/New_York',
       hour: 'numeric',
       hour12: false,
     }).formatToParts(now);
     const nyHour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
     const utcHour = now.getUTCHours();
     const diff = (utcHour - nyHour + 24) % 24;
     return diff === 5 ? 5 : 4;
   }
   ```

3. **Add helper `resolveTradingSessionHours(sessions, now): number[]`:**

   Session definitions in local Eastern hours (start-inclusive, end-exclusive):
   ```typescript
   const SESSION_LOCAL_HOURS: Record<TradingSessionName, number[]> = {
     'asia':         [20, 21, 22, 23],
     'london':       [1, 2, 3, 4],
     'ny-morning':   [7, 8, 9],
     'ny-mid':       [10, 11],
     'ny-afternoon': [12, 13, 14, 15],
   };
   ```
   Convert to UTC by adding the current NY offset, mod 24, dedup, sort:
   ```typescript
   function resolveTradingSessionHours(sessions: TradingSessionName[], now: Date): number[] {
     const offset = getNyUtcOffsetHours(now);
     const hours = new Set<number>();
     for (const session of sessions) {
       for (const localH of SESSION_LOCAL_HOURS[session]) {
         hours.add((localH + offset) % 24);
       }
     }
     return [...hours].sort((a, b) => a - b);
   }
   ```

4. **Update `isWithinTradingHours`** — evaluate `tradingSessions` first:
   ```typescript
   export function isWithinTradingHours(now: Date, tradingHours?: TradingHoursConfig): boolean {
     if (!tradingHours) return true;

     const hour = now.getUTCHours();
     const day = now.getUTCDay();
     const weekendPaused = Boolean(tradingHours.weekendPause)
       && (day === 6 || (day === 0 && hour < 12));
     if (weekendPaused) return false;

     const sessions = tradingHours.tradingSessions;
     if (sessions && sessions.length > 0) {
       return resolveTradingSessionHours(sessions, now).includes(hour);
     }

     const allowedHours = tradingHours.allowedHoursUtc ?? [];
     if (allowedHours.length === 0) return true;
     return allowedHours.includes(hour);
   }
   ```

5. **Update worker `agent.ts`** — thread `tradingSessions` into the `TradingHoursConfig`
   built from `resolvedRuntimePolicy`:
   ```typescript
   const tradingHours: TradingHoursConfig = {
     allowedHoursUtc: resolved.allowedHoursUtc ?? [],
     weekendPause: resolved.weekendPause ?? false,
     tradingSessions: resolved.tradingSessions ?? undefined,
   };
   ```
   Also add `tradingSessions` to the `resolvedRuntimePolicy` type in the `AgentConfig`
   interface in `agent.ts`.

### Checklist
- [ ] `TradingHoursConfig.tradingSessions` added
- [ ] `getNyUtcOffsetHours` returns 4 or 5 correctly
- [ ] `resolveTradingSessionHours` maps each session to UTC, deduplicates, sorts
- [ ] `isWithinTradingHours` evaluates sessions before `allowedHoursUtc`
- [ ] `agent.ts` threads `tradingSessions` from resolved policy into `TradingHoursConfig`
- [ ] `pnpm lint` passes (apps/worker)

---

## Step 3 — Frontend: extend `RuntimePolicyOverrides`

**Status:** DONE

**Files:**
- `apps/web/src/features/agents/style-mapping.ts`

### Changes

1. **Import / re-export `TradingSessionName`** (or duplicate the union — avoid cross-package
   import if the web bundle does not already depend on `@herobids/domain`; otherwise
   import directly):
   ```typescript
   export type TradingSessionName =
     | 'asia' | 'london' | 'ny-morning' | 'ny-mid' | 'ny-afternoon';
   ```

2. **Add to `RuntimePolicyOverrides`:**
   ```typescript
   tradingSessions: TradingSessionName[] | null;
   ```

3. **Update `NumericField` exclusion in `RuntimePolicySection.tsx`** (see Step 4) — this
   is noted here for completeness; the actual edit is in Step 4.

### Checklist
- [ ] `TradingSessionName` exported from `style-mapping.ts`
- [ ] `RuntimePolicyOverrides.tradingSessions` added
- [ ] `pnpm lint` passes (apps/web)

---

## Step 4 — Frontend: session preset UI in `RuntimePolicySection`

**Status:** DONE

**Files:**
- `apps/web/src/features/agents/RuntimePolicySection.tsx`

### Changes

1. **Extend `RuntimePolicySectionProps`:**
   ```typescript
   /** When true, shows trading-session preset shortcuts above the hour grid. */
   showTradingSessionPresets?: boolean;
   ```

2. **Exclude `tradingSessions` from `NumericField`:**
   ```typescript
   type NumericField = Exclude<
     keyof RuntimePolicyOverrides,
     'allowedHoursUtc' | 'weekendPause' | 'tradingSessions'
   >;
   ```

3. **Add a `previewHoursForSessions(sessions, now)` helper** (mirrors the worker logic
   for the read-only preview — uses `Intl.DateTimeFormat('America/New_York')` with the
   same math as the worker helper):
   ```typescript
   const SESSION_LOCAL_HOURS: Record<TradingSessionName, number[]> = {
     'asia':         [20, 21, 22, 23],
     'london':       [1, 2, 3, 4],
     'ny-morning':   [7, 8, 9],
     'ny-mid':       [10, 11],
     'ny-afternoon': [12, 13, 14, 15],
   };

   function previewHoursForSessions(sessions: TradingSessionName[], now = new Date()): number[] {
     const parts = new Intl.DateTimeFormat('en-US', {
       timeZone: 'America/New_York', hour: 'numeric', hour12: false,
     }).formatToParts(now);
     const nyHour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
     const offset = (now.getUTCHours() - nyHour + 24) % 24; // 4 or 5
     const set = new Set<number>();
     for (const s of sessions) {
       for (const h of SESSION_LOCAL_HOURS[s]) set.add((h + offset) % 24);
     }
     return [...set].sort((a, b) => a - b);
   }
   ```

4. **Add `TradingSessionPresets` sub-component** (rendered above `weekendPause` and the
   hour grid, only when `showTradingSessionPresets` is true):

   Session metadata for labels:
   ```typescript
   const SESSIONS: Array<{ key: TradingSessionName; labelId: string; subtitleId: string }> = [
     { key: 'asia',         labelId: 'agents.runtimePolicy.session.asia',         subtitleId: 'agents.runtimePolicy.session.asia.subtitle' },
     { key: 'london',       labelId: 'agents.runtimePolicy.session.london',       subtitleId: 'agents.runtimePolicy.session.london.subtitle' },
     { key: 'ny-morning',   labelId: 'agents.runtimePolicy.session.nyMorning',    subtitleId: 'agents.runtimePolicy.session.nyMorning.subtitle' },
     { key: 'ny-mid',       labelId: 'agents.runtimePolicy.session.nyMid',        subtitleId: 'agents.runtimePolicy.session.nyMid.subtitle' },
     { key: 'ny-afternoon', labelId: 'agents.runtimePolicy.session.nyAfternoon',  subtitleId: 'agents.runtimePolicy.session.nyAfternoon.subtitle' },
   ];
   ```

   Behaviour:
   - Each session is a labeled checkbox.
   - Checking a session: adds to `tradingSessions`; clears `allowedHoursUtc` override.
   - Unchecking the last session: clears `tradingSessions`; hour grid becomes editable.
   - Render a `TradingSessionLabel` showing name + local time hint (e.g.
     `"Asia — 8 pm – 12 am ET"`).

5. **Update `HourGrid` to accept an `isPreview` flag:**
   When `isPreview=true`, render hours as non-interactive (no `onChange` on labels,
   pointer-events disabled, different opacity for hours not in the preview set).

6. **Wire preview into the grid:**
   ```typescript
   const activeSessions = overrides?.tradingSessions ?? [];
   const previewHours = activeSessions.length > 0
     ? previewHoursForSessions(activeSessions)
     : null;
   // Pass to HourGrid:
   selected={previewHours ?? overrides?.allowedHoursUtc ?? null}
   isPreview={activeSessions.length > 0}
   ```

### Checklist
- [ ] `showTradingSessionPresets` prop added and destructured
- [ ] `tradingSessions` excluded from `NumericField`
- [ ] `previewHoursForSessions` helper present and correct
- [ ] `TradingSessionPresets` renders 5 checkboxes (in order: Asia, London, NY Morning, NY Mid, NY Afternoon)
- [ ] Checking a session sets `tradingSessions`, clears `allowedHoursUtc`
- [ ] Unchecking last session clears `tradingSessions`
- [ ] `HourGrid` shows preview (non-interactive) when sessions are active
- [ ] `HourGrid` is editable when no sessions are selected
- [ ] `weekendPause` remains unaffected (always editable)
- [ ] `pnpm lint` passes

---

## Step 5 — Frontend: thread `showTradingSessionPresets` from callers

**Status:** PENDING

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`

Both files already have `showTradingControls` (or `requiresTradingSetup`) computed.
Pass it as `showTradingSessionPresets` to `RuntimePolicySection`:

```tsx
<RuntimePolicySection
  style={intent.style}
  overrides={intent.runtimePolicyOverrides}
  onChange={...}
  showTradingSessionPresets={showTradingControls}  // ← new prop
/>
```

Apply the same change in `EditAgentModal.tsx`.

### Checklist
- [ ] `AgentsPage.tsx` passes `showTradingSessionPresets={showTradingControls}`
- [ ] `EditAgentModal.tsx` passes `showTradingSessionPresets={showTradingControls}`
- [ ] `pnpm lint` passes

---

## Step 6 — i18n strings

**Status:** PENDING

**Files:**
- `apps/web/src/app/i18n/locales/en.ts`
- `apps/web/src/app/i18n/locales/hi.ts`
- `apps/web/src/app/i18n/locales/ar.ts`

### New keys (`en.ts` values)

```typescript
'agents.runtimePolicy.tradingSessionsLabel':           'Trading Sessions',
'agents.runtimePolicy.tradingSessionsHelp':            'Shortcuts for common market windows (Eastern Time). Selecting one or more replaces the manual hour grid; hours adjust automatically for daylight saving time.',
'agents.runtimePolicy.session.asia':                   'Asia',
'agents.runtimePolicy.session.asia.subtitle':          '8 pm – 12 am ET',
'agents.runtimePolicy.session.london':                 'London',
'agents.runtimePolicy.session.london.subtitle':        '1 am – 5 am ET',
'agents.runtimePolicy.session.nyMorning':              'New York Morning',
'agents.runtimePolicy.session.nyMorning.subtitle':     '7 am – 10 am ET',
'agents.runtimePolicy.session.nyMid':                  'New York Mid',
'agents.runtimePolicy.session.nyMid.subtitle':         '10 am – 12 pm ET',
'agents.runtimePolicy.session.nyAfternoon':            'New York Afternoon',
'agents.runtimePolicy.session.nyAfternoon.subtitle':   '12 pm – 4 pm ET',
'agents.runtimePolicy.sessionPreviewNote':             'Preview (UTC, current offset)',
```

Add matching keys to `hi.ts` and `ar.ts` (translate or use English as placeholder).

### Checklist
- [ ] All 12 keys added to `en.ts`
- [ ] Matching keys added to `hi.ts` (translated or English placeholders acceptable)
- [ ] Matching keys added to `ar.ts` (translated or English placeholders acceptable)

---

## Step 7 — Tests

**Status:** PENDING

**Files:**
- `apps/worker/src/tick-gates.test.ts`
- `packages/domain/src/config/schema.test.ts` (or `runtime-policy-propagation.integration.test.ts`)

### tick-gates tests

```typescript
describe('isWithinTradingHours — trading sessions', () => {
  it('allows tick during Asia session (EDT)', () => {
    // 2026-07-01T01:30:00Z = 9:30 pm EDT → inside Asia (8 pm–12 am ET)
    expect(isWithinTradingHours(
      new Date('2026-07-01T01:30:00Z'),
      { tradingSessions: ['asia'] },
    )).toBe(true);
  });

  it('blocks tick outside Asia session (EDT)', () => {
    // 2026-07-01T10:00:00Z = 6 am EDT → outside Asia
    expect(isWithinTradingHours(
      new Date('2026-07-01T10:00:00Z'),
      { tradingSessions: ['asia'] },
    )).toBe(false);
  });

  it('sessions union correctly — Asia + London covers both windows', () => {
    // 2026-07-01T06:30:00Z = 2:30 am EDT → inside London (1–5 am ET)
    expect(isWithinTradingHours(
      new Date('2026-07-01T06:30:00Z'),
      { tradingSessions: ['asia', 'london'] },
    )).toBe(true);
  });

  it('sessions respected in winter (EST — UTC-5)', () => {
    // 2026-01-07T06:30:00Z = 1:30 am EST → inside London (1–5 am ET, UTC-5 → UTC 6-10)
    expect(isWithinTradingHours(
      new Date('2026-01-07T06:30:00Z'),
      { tradingSessions: ['london'] },
    )).toBe(true);
  });

  it('weekendPause takes priority over sessions', () => {
    // Saturday UTC
    expect(isWithinTradingHours(
      new Date('2026-07-04T02:00:00Z'),
      { tradingSessions: ['asia'], weekendPause: true },
    )).toBe(false);
  });

  it('empty tradingSessions falls back to allowedHoursUtc', () => {
    expect(isWithinTradingHours(
      new Date('2026-07-01T05:00:00Z'),
      { tradingSessions: [], allowedHoursUtc: [5] },
    )).toBe(true);
  });
});
```

### Schema tests

```typescript
it('accepts tradingSessions in AgentRuntimePolicyOverridesSchema', () => {
  const r = AgentRuntimePolicyOverridesSchema.safeParse({
    tradingSessions: ['asia', 'london'],
  });
  expect(r.success).toBe(true);
});

it('rejects unknown session name', () => {
  const r = AgentRuntimePolicyOverridesSchema.safeParse({
    tradingSessions: ['bogus'],
  });
  expect(r.success).toBe(false);
});
```

### Checklist
- [ ] All tick-gates session tests pass
- [ ] Schema tests pass
- [ ] `pnpm test` passes overall

---

## Step 8 — Final lint & type-check

**Status:** PENDING

```bash
pnpm lint   # must pass with zero errors
pnpm test   # all tests green
```

---

## Files changed (summary)

| File | Change |
|---|---|
| `packages/domain/src/config/schema.ts` | `TradingSessionName`, extend `AgentRuntimePolicyOverridesSchema` + `ResolvedAgentRuntimePolicy` |
| `apps/worker/src/tick-gates.ts` | `TradingHoursConfig.tradingSessions`, DST helpers, updated `isWithinTradingHours` |
| `apps/worker/src/agent.ts` | Thread `tradingSessions` into `TradingHoursConfig` build |
| `apps/web/src/features/agents/style-mapping.ts` | `TradingSessionName`, `RuntimePolicyOverrides.tradingSessions` |
| `apps/web/src/features/agents/RuntimePolicySection.tsx` | Session preset checkboxes, preview grid mode, `showTradingSessionPresets` prop |
| `apps/web/src/features/agents/AgentsPage.tsx` | Pass `showTradingSessionPresets` |
| `apps/web/src/features/agents/EditAgentModal.tsx` | Pass `showTradingSessionPresets` |
| `apps/web/src/app/i18n/locales/en.ts` | 12 new keys |
| `apps/web/src/app/i18n/locales/hi.ts` | 12 new keys |
| `apps/web/src/app/i18n/locales/ar.ts` | 12 new keys |
| `apps/worker/src/tick-gates.test.ts` | Session gate tests |
| `packages/domain/src/config/schema.test.ts` | `tradingSessions` schema tests |

No database migration is required — `tradingSessions` is stored inside the existing
`runtime_policy_overrides` JSONB column.

---

## Outstanding Issues

### [Step 1] LOW — `TradingSessionName` uses `typeof TRADING_SESSION_NAMES[number]` pattern (cosmetic)

Idiomatic and correct — no action needed for Step 1.

### [Step 1] LOW — `tradingSessions` in `AgentRuntimePolicyOverridesSchema` is `z.array(...).nullable().optional()`

Consistent with other fields. Semantics: `undefined` → style default, `null` → style default, `[]` → explicit "no sessions." No action needed.

### [Step 2] LOW — `getNyUtcOffsetHours` returns `number` instead of plan's `4 | 5`

The runtime assertion `if (diff !== 4 && diff !== 5) throw` makes a literal union type impossible without a type assertion. No behavioral impact — `number` works identically for the arithmetic usage `(localH + offset) % 24`. Plan could be updated to reflect `number`.

### [Step 3] LOW — `AgentStyleValue` duplicated locally in web (pre-existing)

The type `'careful' | 'balanced' | 'bold'` exists in both `@herobids/domain` and `apps/web/src/features/agents/style-mapping.ts`. If a fourth style is added to domain, the web's local type will silently diverge. Pre-existing — not introduced by this change.

### [Step 3] LOW — `StyleDefaults` lacks `tradingSessions` field

Trading sessions can only be supplied via overrides, not via style presets. This is by design — sessions are market-window conveniences, not risk-tier characteristics.

### [Step 4] MEDIUM — No unit tests for RuntimePolicySection component

Non-trivial state logic (numeric override CRUD, weekendPause toggling, session preset selection with auto-clear, HourGrid custom-vs-default detection, timezone offset computation) warrants test coverage. Deferred to Step 7.

### [Step 4] LOW — `!` non-null assertion on `SESSION_LOCAL_HOURS[s]`

Safe for the exhaustive Record, but if `TradingSessionName` gains a sixth value without updating the Record, `undefined` values would silently appear. Consider an assertion helper in future.

### [Step 4] LOW — Hardcoded English labels

Session preset labels are hardcoded. Step 6 will add i18n keys to replace them.
