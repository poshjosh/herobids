# 001 — Hybrid Signal Deduplication: Skip Wakes When Scanner Signals Haven't Changed

**Status:** Planned  
**Created:** 2026-07-17  
**Depends on:** [004-hybrid-mode-split](../../07/11/004-hybrid-mode-split/001-plan.md) (implemented)

## Problem

Scanner-gated hybrid agents call the LLM on every scanner wake. Fix A (2-min
scanner wake cooldown in `wakePolicy`) limits the frequency, but the agent is
still woken every 2 minutes to re-evaluate signals that haven't changed.

The wasteful case: the scanner scans 20 instruments, finds the same top-3
signals (LIT-PERP at ~0.90, ETH-PERP at ~0.40, UNI-PERP at ~0.40) scan after
scan. Each time the agent is woken, the LLM evaluates the same data and reaches
the same conclusion. ~600 tokens per evaluation × 30 evals/hour = ~18,000
tokens/hour burned on redundant work.

## Design

**One check. One Redis key.**

Before the scanner emits a wake, hash the top N signals + exit advisory symbols.
If the hash matches the previous scan's hash → skip the wake. No LLM call, zero
tokens.

When something actually changes — a new instrument enters the top set,
confidence moves meaningfully, or an exit advisory appears — the hash changes
and the agent is woken.

```
Scanner completes scan
  │
  ▼
Hash top 5 signals + exit advisories
  │
  ├── Same as last scan? ──→ Skip wake (0 tokens)
  │
  └── Different? ──→ Emit wake → LLM evaluates (~600 tokens)
```

### Fingerprint

Not a cryptographic hash — a simple deterministic string built from sorted,
stable inputs so two scans with the same signals always produce the same string:

```
LIT-PERP:0.90|ETH-PERP:0.40|UNI-PERP:0.40|exit:none
```

Components:
- **Top 5 signals** by confidence: `instrumentId:confidenceBucket` sorted alphabetically by instrumentId
- **Confidence bucketed** to ±0.03 bands to absorb noise (0.40 → `0.42`, 0.90 → `0.90`)
- **Exit advisory symbols** sorted alphabetically, or `none`
- **Regime pass/fail** if available (`regime:pass` / `regime:block` / `regime:unavailable`)

### Bucketing Confidence

Raw confidence has noise. 0.40 and 0.42 are the same signal. Rounding to 0.03
bands makes them collide:

```typescript
function bucketConfidence(value: number, bucketSize: number): string {
  return (Math.round(value / bucketSize) * bucketSize).toFixed(2);
}
// bucketConfidence(0.40, 0.03) → "0.39"  (nearest 0.03 multiple)
// bucketConfidence(0.42, 0.03) → "0.42"
// Actually simpler: round to nearest 0.05.
// bucketConfidence(0.40, 0.05) → "0.40"
// bucketConfidence(0.42, 0.05) → "0.40"  ← same bucket, noise absorbed
// bucketConfidence(0.48, 0.05) → "0.50"  ← different bucket
```

Use **0.05 bands** — clean, predictable, and confidence changes smaller than
±0.05 are almost certainly noise.

### What Triggers a Wake vs. What Doesn't

| Scenario | Fingerprint changes? | Agent woken? |
|----------|---------------------|-------------|
| Same 3 signals, same confidence | No | ❌ Skipped |
| Same 3 signals, LIT confidence 0.90 → 0.94 | No (same 0.90 bucket) | ❌ Skipped |
| Same 3 signals, ETH confidence 0.40 → 0.52 | Yes (0.40 → 0.50 bucket) | ✅ Woken |
| New instrument enters top 5 | Yes (new instrumentId) | ✅ Woken |
| Instrument drops out of top 5 | Yes (missing instrumentId) | ✅ Woken |
| Exit advisory appears on open position | Yes (`exit:HYPE-PERP`) | ✅ Woken |
| Exit advisory resolves | Yes (`exit:none`) | ✅ Woken |
| Regime flips PASS → BLOCK | Yes (`regime:pass` → `regime:block`) | ✅ Woken |
| Signals rotate A,B,C → B,C,D → A,B,C | Yes when set changes, No when it cycles back | ✅ then ❌ |

### Edge Case: LLM Skips, Scanner Re-Finds

If the LLM evaluated all signals and decided `skip` on every one, and the next
scan produces the same signals — the fingerprint matches and the wake is
suppressed. This is **correct behavior**: if the LLM already decided these
signals aren't actionable, and nothing about the signals changed, there's no
reason to ask again.

If the LLM skipped because of a transient condition (e.g. "max positions
reached"), and that condition later resolves, the fingerprint hasn't changed
but the answer might. This is the one gap — but it's narrow:

1. Transient conditions like position count change infrequently.
2. The 2-min scanner wake cooldown already bounds this to ~1 extra call.
3. The fingerprint TTL (10 min) means the check expires and a full wake
   eventually happens even with no signal change.

## Implementation

### Files changed

| File | Action |
|------|--------|
| `apps/worker/src/complete-technical-scan.ts` | Add `computeSignalFingerprint()` + Redis read/write + wake suppression |
| `apps/worker/src/complete-technical-scan.test.ts` | Tests |
| `config/default.yaml` | No new config needed — hardcoded defaults are fine |

### No new config

Hardcoded defaults are sufficient for v1:

| Parameter | Value | Why |
|-----------|-------|-----|
| `fingerprintTopN` | 5 | Top 5 signals capture the actionable set |
| `confidenceBucketSize` | 0.05 | Noise absorption without losing real changes |
| `fingerprintTtlSeconds` | 600 | 10 min — ensures a full re-evaluation eventually |

If we later need per-strategy tuning, `confidenceBucketSize` is the only knob
worth exposing. Everything else is an implementation detail.

### Code sketch (~30 lines)

```typescript
// apps/worker/src/complete-technical-scan.ts

function computeSignalFingerprint(
  signals: TechnicalSignal[],
  exitAdvisorySymbols: string[],
  regimePass: boolean | null,
): string {
  const signalParts = signals
    .slice(0, 5)
    .map(s => `${s.instrumentId}:${bucketConfidence(s.confidence, 0.05)}`)
    .sort();
  const exitPart = exitAdvisorySymbols.length > 0
    ? `exit:${[...exitAdvisorySymbols].sort().join(',')}`
    : 'exit:none';
  const regimePart = regimePass === null ? 'regime:unavailable'
    : regimePass ? 'regime:pass' : 'regime:block';
  return [...signalParts, exitPart, regimePart].join('|');
}

function bucketConfidence(value: number, size: number): string {
  return (Math.round(value / size) * size).toFixed(2);
}

// Inside completeTechnicalScan, before emitAgentWake:
const fingerprint = computeSignalFingerprint(
  phaseResult.signals,
  phaseResult.positionIndicators.filter(i => i.exitAdvisory).map(i => i.symbol),
  phaseResult.regimeResult?.pass ?? null,
);

const fpKey = `agent:scanner:fingerprint:${agentId}`;
const prevFingerprint = await redis.get(fpKey);
if (fingerprint === prevFingerprint) {
  logger.debug({ agentId, fingerprint }, 'Scanner signals unchanged — suppressing wake');
  return scan;
}

// New or changed signals — store fingerprint and proceed with wake
await redis.set(fpKey, fingerprint, 'EX', 600);
```

### Redis dependency

The `completeTechnicalScan` function currently receives `emitAgentWake` but not
a Redis client. The caller (`AgentTradingActor.runTechnicalScan`) has access to
Redis via `this.redis`. Pass it through as a new parameter on
`CompleteTechnicalScanParams`:

```typescript
export interface CompleteTechnicalScanParams {
  // ... existing fields ...
  redis?: Pick<Redis, 'get' | 'set'>;  // optional — dedup is skipped when absent
}
```

Fail-open: if `redis` is not provided, fingerprint check is skipped and the
wake proceeds as today. Zero risk to existing callers.

### Test cases

| Test | Expected |
|------|----------|
| Identical signals, same confidence → same fingerprint | Wake suppressed |
| Same instruments, confidence changed by ≥ 0.05 | Wake emitted |
| Same instruments, confidence changed by < 0.05 (noise) | Wake suppressed |
| New instrument enters top 5 | Wake emitted |
| Exit advisory appears | Wake emitted |
| Exit advisory resolves | Wake emitted |
| Regime flips | Wake emitted |
| Redis unavailable (get returns null/error) | Wake emitted (fail-open) |
| Empty signals, no exits, no regime | Wake emitted (first scan, no previous fingerprint) |

## Rollback

Delete the Redis key and restart workers:

```bash
redis-cli KEYS "agent:scanner:fingerprint:*" | xargs redis-cli DEL
```

Or set `fingerprintTopN: 0` (future config) → fingerprint always `""` → always
wakes (never matches previous).

## What We're Not Doing (Yet)

- **Per-instrument evaluation cooldown.** Adds complexity (N Redis keys, TTL
  management, "already decided" tracking) for a problem we haven't observed.
  The fingerprint gate alone catches the common case: same signals, same answer.

- **Context hash gate integration.** Would require changing `shouldSkipTick`
  gating logic for all agent modes. The fingerprint gate achieves the same
  outcome (suppress LLM on unchanged signals) with a single check in the
  scanner loop — no gate changes needed.

Ship the fingerprint gate, measure the reduction in evals/hour, and only add
more layers if the data shows they're needed.
