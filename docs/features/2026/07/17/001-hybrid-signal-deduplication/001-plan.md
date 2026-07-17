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

Before the scanner emits a wake, fingerprint the current actionable signal set
plus exit advisory symbols. If the fingerprint matches the previous scan's
fingerprint → skip the wake. No LLM call, zero tokens.

When something actually changes — a new instrument enters the top set,
confidence moves meaningfully, or an exit advisory appears — the hash changes
and the agent is woken.

```
Scanner completes scan
  │
  ▼
Fingerprint top N signals + exit advisories
  │
  ├── Same as last scan? ──→ Skip wake (0 tokens)
  │
  └── Different? ──→ Emit wake → LLM evaluates (~600 tokens)
```

### Fingerprint

This is intentionally a **set-based** fingerprint, not a rank-sensitive one.
The technical scan already returns signals sorted by descending confidence; we
select the top N from that ordered list, then canonicalize them alphabetically
by `instrumentId` so that rank churn inside the same top set does **not** wake
the agent.

Not a cryptographic hash — a simple deterministic string built from sorted,
stable inputs so two scans with the same signals always produce the same string:

```
LIT-PERP:0.90|ETH-PERP:0.40|UNI-PERP:0.40|exit:none
```

Components:
- **Top N signals** selected from the scanner's existing confidence-sorted output,
  then canonicalized as `instrumentId:confidenceBucket` sorted alphabetically by
  `instrumentId`
- **Confidence bucketed** with an operator-configured bucket size so small
  confidence noise does not trigger a wake
- **Exit advisory symbols** sorted alphabetically, or `none`
- **Regime pass/fail** if available (`regime:pass` / `regime:block` / `regime:unavailable`)

Implication: if the top set stays `{A, B, C}` and only the internal ranking
changes `A,B,C -> B,A,C`, the fingerprint stays the same and the wake is
suppressed. That is the intended behavior for v1.

### Bucketing Confidence

Raw confidence has noise. 0.40 and 0.42 are the same signal. We should expose
the bucket size through operator config and default it to `0.05` in
`config/default.yaml`.

```typescript
function bucketConfidence(value: number, bucketSize: number): string {
  return (Math.round(value / bucketSize) * bucketSize).toFixed(2);
}
// bucketConfidence(0.40, 0.05) → "0.40"
// bucketConfidence(0.42, 0.05) → "0.40"  ← same bucket, noise absorbed
// bucketConfidence(0.48, 0.05) → "0.50"  ← different bucket
```

Default to **0.05 bands** — clean, predictable, and confidence changes smaller
than ±0.05 are almost certainly noise. This remains an operator-owned policy
value, not a hardcoded literal in business logic.

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
| Same top set, same buckets, only ranking order changes | No | ❌ Skipped |

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
3. The fingerprint TTL means the check expires and a full wake eventually
  happens even with no signal change.

## Implementation

### Files changed

| File | Action |
|------|--------|
| `apps/worker/src/agent-trading-actor.ts` | Add fingerprint-gate logic before wake emission; wrap Redis access in fail-open handling |
| `apps/worker/src/complete-technical-scan.ts` | Keep helper pure; optionally add/export `computeSignalFingerprint()` only |
| `apps/worker/src/agent-trading-actor.test.ts` or `apps/worker/src/scanner-gated-phase2.test.ts` | Actor-level dedupe tests |
| `apps/worker/src/complete-technical-scan.test.ts` | Keep/update pure wake behavior tests; no Redis coupling |
| `apps/worker/src/redis-keys.ts` | Add `scannerSignalFingerprintKey(agentId)` helper |
| `config/default.yaml` | Add operator-owned dedupe config with documented defaults |
| `packages/domain/src/config/schema.ts` | Add Zod schema/defaults for dedupe config |

### Operator config

This feature should use operator config, not hardcoded literals in worker code.
Suggested home: `agentRuntime.scannerSignalDedup`.

```yaml
agentRuntime:
  scannerSignalDedup:
    enabled: true
    topN: 5
    confidenceBucketSize: 0.05
    ttlSeconds: 600
```

| Parameter | Default | Why |
|-----------|---------|-----|
| `enabled` | `true` | Real rollback switch; disable without code change |
| `topN` | `5` | Top 5 signals capture the actionable set |
| `confidenceBucketSize` | `0.05` | Noise absorption without losing real changes |
| `ttlSeconds` | `600` | Forces eventual full re-evaluation even with unchanged signals |

Notes:
- No env override is needed; this is structured operator policy and belongs in YAML.
- `enabled` and `ttlSeconds` are required for operational rollback/fail-open hygiene.

### Code sketch (~40 lines)

```typescript
// apps/worker/src/complete-technical-scan.ts

function computeSignalFingerprint(
  signals: TechnicalSignal[],
  exitAdvisorySymbols: string[],
  regimePass: boolean | null,
  topN: number,
  bucketSize: number,
): string {
  const signalParts = signals
    .slice(0, topN)
    .map((signal) => `${signal.instrumentId}:${bucketConfidence(signal.confidence, bucketSize)}`)
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

// apps/worker/src/agent-trading-actor.ts

let wakeEmitter = this.deps.emitAgentWake;

if (this.deps.scannerSignalDedup?.enabled && wakeEmitter) {
  const exitAdvisorySymbols = phaseResult.positionIndicators
    .filter((indicator) => indicator.exitAdvisory === true)
    .map((indicator) => indicator.symbol);

  const fingerprint = computeSignalFingerprint(
    phaseResult.signals,
    exitAdvisorySymbols,
    phaseResult.regimeResult?.pass ?? null,
    this.deps.scannerSignalDedup.topN,
    this.deps.scannerSignalDedup.confidenceBucketSize,
  );

  try {
    const key = scannerSignalFingerprintKey(agentId);
    const previous = await this.deps.signalFingerprintStore?.get(key);

    if (previous === fingerprint) {
      this.logger.debug({ agentId, fingerprint }, 'Scanner signals unchanged — suppressing wake');
      wakeEmitter = undefined;
    } else {
      await this.deps.signalFingerprintStore?.set(
        key,
        fingerprint,
        'EX',
        this.deps.scannerSignalDedup.ttlSeconds,
      );
    }
  } catch (err) {
    this.logger.warn({ err, agentId }, 'Scanner signal dedup failed — proceeding with wake');
  }
}

await completeTechnicalScan({
  phaseResult,
  technicalConfig,
  agentId,
  isHybridMode: !!this.deps.isHybridMode,
  onTechnicalScanComplete: this.deps.onTechnicalScanComplete,
  emitAgentWake: wakeEmitter,
  onJournalEvent: this.deps.onJournalEvent,
});
```

### Redis dependency

Keep `completeTechnicalScan` pure. It was extracted specifically so the scan
completion path can be tested without Redis or venue infrastructure. The Redis
read/write belongs one layer up, in `AgentTradingActor.runTechnicalScan`, where
the actor can decide whether to pass `emitAgentWake` through unchanged or
suppress it for this scan.

Add the Redis dependency to actor deps as a minimal store interface, wired from
worker bootstrap where Redis already exists:

```typescript
export interface AgentTradingActorDeps {
  // ... existing fields ...
  signalFingerprintStore?: Pick<Redis, 'get' | 'set'>;
  scannerSignalDedup?: {
    enabled: boolean;
    topN: number;
    confidenceBucketSize: number;
    ttlSeconds: number;
  };
}
```

Fail-open requirements:
- If the store is absent, behave exactly as today.
- If Redis `get` throws, log and emit the wake.
- If Redis `set` throws, log and emit the wake.
- Never let dedupe failure prevent `onTechnicalScanComplete` forwarding or wake emission.

### Redis key ownership

Do not inline the fingerprint key format in the actor. Add a helper to
`apps/worker/src/redis-keys.ts`, e.g. `scannerSignalFingerprintKey(agentId)`,
so the namespace stays centralized like the existing scanner-gated key helpers.

### Test cases

| Test | Expected |
|------|----------|
| Identical signals, same confidence → same fingerprint | Wake suppressed |
| Same top set, same buckets, ranking order changes only | Wake suppressed |
| Same instruments, confidence changed by ≥ 0.05 | Wake emitted |
| Same instruments, confidence changed by < 0.05 (noise) | Wake suppressed |
| New instrument enters top 5 | Wake emitted |
| Exit advisory appears | Wake emitted |
| Exit advisory resolves | Wake emitted |
| Regime flips | Wake emitted |
| Dedup disabled in config | Wake emitted |
| Redis `get` throws | Wake emitted and scan still forwarded |
| Redis `set` throws | Wake emitted and scan still forwarded |
| Store dependency absent | Wake emitted (current behavior) |
| Empty signals, no exits, no regime | Wake emitted (first scan, no previous fingerprint) |

Test split:
- `complete-technical-scan.test.ts` stays focused on pure scan completion and wake semantics.
- Actor/integration tests cover fingerprint suppression, store failures, and config-driven enable/disable.

## Rollback

Primary rollback: disable the feature in operator config and restart workers.

```yaml
agentRuntime:
  scannerSignalDedup:
    enabled: false
```

Optional cleanup: let TTL expiry drain old keys naturally, or delete them with
`SCAN`-based iteration if immediate cleanup is required:

```bash
redis-cli --scan --pattern 'agent:scanner:fingerprint:*' | while read -r key; do redis-cli DEL "$key"; done
```

Do not rely on `KEYS` in production-era rollback instructions, and do not rely
on a hypothetical `topN: 0` escape hatch.

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

## Open Questions

No blocking open questions remain for implementation.

Optional follow-ups only:

- **Observability depth.** Decide whether v1 should emit dedicated metrics such
  as `scanner_signal_dedup_hits`, `scanner_signal_dedup_misses`, and
  `scanner_signal_dedup_failures`, or whether debug/warn logs are sufficient for
  the first pass.
- **Config namespace naming.** This plan recommends `agentRuntime.scannerSignalDedup`.
  If the team prefers a different operator-config namespace, settle that before
  implementation and use it consistently across YAML, Zod schema, and worker wiring.
