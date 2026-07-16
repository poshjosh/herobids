# Staging Read-Only Diagnostic: scanner_gated Agents Not Trading

**Date:** 2026-07-16 ~16:30 UTC
**Server:** 128.140.55.192 (staging)
**Git HEAD:** `913f4ae05` (our fix commits `094b7da2` / `b5353e06` / `4e53031e` NOT deployed)

---

## 1. Deployment Identity

| Item | Value |
|------|-------|
| Git HEAD | `913f4ae053850330bb8623a67dc5727131b16d45` |
| Git untracked | `Caddyfile.active` |
| Worker image | `herobids-worker` |
| Worker created | 2026-07-16T13:45:52Z (~3h before diagnostic) |
| Worker status | running |
| All services | 7/7 healthy (api, caddy, docker-proxy, postgres, redis, web, worker) |

**Observation:** The `applyConfigDefaults()` fix has NOT been deployed. The running worker does NOT contain the fix code.

---

## 2. Active Hybrid Agent Config

All 7 agents share the same pattern: `scanBatchSize` and `scanIntervalMs` are **NULL** in the stored JSONB.

| Short ID | Name | Capability | Hybrid Mode | scanBatchSize | scanIntervalMs | Filters | Candles | Indicators |
|----------|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `70b3d865` | tcontrarian | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `51403f2e` | tmomentum-d | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `93552994` | tmomentum-p | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `64afd699` | trange | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `3fa538e3` | tscalper | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `b4f67404` | tswing | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |
| `15bfaf97` | tswing-playbook | hybrid | scanner_gated | **NULL** | **NULL** | ✓ | ✓ | ✓ |

**Observation:** The undefined-default defect documented in `003-technical-config-scan-defaults-not-applied-at-load.md` is **actively affecting** this deployment. `filters`, `candles`, and `indicators` are all populated — only `scanBatchSize` and `scanIntervalMs` are missing.

---

## 3. Scanner Evidence

### Typical scan cycle (all 7 agents, every cycle)

```
[16:32:46] INFO (agent-actor-70b3d865): Technical phase: advisory mode — skipping entry submissions
    signalCount: 0
[16:32:46] INFO (agent-actor-70b3d865): Technical phase complete
    candidatesDiscovered: 232
    candidatesScored: 0        ← ZERO (candle-fetch loop never executes)
    signalsGenerated: 0         ← ZERO (nothing scored)
    entriesSubmitted: 0
    exitsSubmitted: 0
    regimeBlocked: false
    errorCount: 0               ← no errors (loop body skipped, not failed)
```

### Per-Agent Summary

| Agent | Scans/sec | Discovered | Scored | Signals | Errors | Scan Gap |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|
| tcontrarian | ~10/s | 232 | 0 | 0 | 0 | <1s |
| tmomentum-d | ~10/s | 232 | 0 | 0 | 0 | <1s |
| tmomentum-p | ~10/s | 232 | 0 | 0 | 0 | <1s |
| trange | ~10/s | 232 | 0 | 0 | 0 | <1s |
| tscalper | ~10/s | 232 | 0 | 0 | 0 | <1s |
| tswing | ~10/s | 232 | 0 | 0 | 0 | <1s |
| tswing-playbook | ~10/s | 232 | 0 | 0 | 0 | <1s |

### Error Logs

- **Candle fetch failures:** 0
- **Scan loop errors:** 0
- **Failed to emit technical scan:** 0
- **Failed to publish to Redis Stream:** 0

### Scan Interval Evidence

Consecutive scans for `tcontrarian` (agent-actor-70b3d865) all carry the same second timestamp `[16:32:46]` — 10 scans within the same second confirms sub-second intervals from `setInterval(fn, undefined)`.

### Log Volume

- **220,789 lines in 90 minutes** (~41 lines/sec)
- All lines are repetitive "Technical phase complete" / "advisory mode" output
- No errors, warnings, or anomalies detected in the scan output

**Observation:** The two symptoms of the defect are both present: (a) `candidatesScored: 0` with `errorCount: 0` (the candle-fetch loop is silently skipped, not failing), and (b) sub-second scan intervals (the undefined `scanIntervalMs` drives a ~1ms timer loop).

---

## 4. Wake and Agent-Runtime Evidence

### Redis `agent:scanner_gated:*` Keys

7 keys present (one per agent) — the scanner_gated registration is working.

### Agent Outbound Streams

| Stream | Length |
|--------|:---:|
| `agent:outbound:70b3d865` | **0** |
| `agent:outbound:51403f2e` | **0** |
| `agent:outbound:93552994` | **0** |
| `agent:outbound:64afd699` | **0** |
| `agent:outbound:3fa538e3` | **0** |
| `agent:outbound:b4f67404` | **0** |
| `agent:outbound:15bfaf97` | **0** |

`XREVRANGE` returns empty for all agents.

### Event Counts

| Event Type | Count |
|------------|:---:|
| `agent.technical.scan_completed` | **0** |
| `agent.wake` with `source: scanner` | **0** |

**Observation:** The entire wake chain is broken. Scanner produces 0 signals → no wake emitted → hybrid evaluator never triggered → agent outbound streams empty → 0 trades.

The agent containers were not directly accessible (Docker-in-Docker/Nomad runtime), so agent-container-level hybrid evaluator logs could not be collected. However, the Redis stream evidence is sufficient to confirm the chain is broken — the downstream components receive nothing.

---

## 5. Candle Provider Reachability

**Test:** Binance `SOLUSDT` 15m klines, limit=3
**Result:** HTTP 200, valid kline array returned

```json
[[1784217600000,"76.63000000","76.63000000","76.23000000","76.31000000",...]]
```

**Observation:** Binance API is reachable and responsive. The failure is NOT a provider/network issue — the code path to fetch candles is never reached due to the `scanBatchSize: undefined` → `NaN` defect in the loop condition.

---

## 6. Operational Pressure

| Container | CPU % | Memory | Mem % |
|-----------|:---:|--------|:---:|
| herobids-worker-1 | **62.53%** | 528.4 MiB / 3.73 GiB | 13.83% |
| herobids-redis-1 | 12.03% | 182.8 MiB / 3.73 GiB | 4.79% |

- **Worker CPU at 62%** — consistent with 7 agents scanning at sub-second intervals (the `undefined` scan interval defect causes a tight loop)
- **No memory pressure** — Redis and worker are within normal bounds
- **Log volume:** 220,789 lines in 90 minutes, all repetitive scan completion output
- **Scan overlap:** Timestamps show all 7 agents scan within the same second, confirming scans fire independently in rapid succession

---

## 7. Conclusions

### Confirmed: The defect IS active on staging

1. **`scanBatchSize` and `scanIntervalMs` are NULL** in all 7 agents' stored config — the `applyConfigDefaults()` fix (commit `094b7da2`) has not been deployed to this server.

2. **The two observable symptoms match the defect exactly:**
   - `candidatesScored: 0` with `errorCount: 0` (the `i += undefined → NaN` loop skip)
   - Sub-second scan intervals (the `setInterval(fn, undefined) → ~1ms` tight loop)

3. **No other issues detected:**
   - Binance API is reachable (HTTP 200)
   - Market data discovery works (232 Hyperliquid assets found)
   - Agent config has filters, candles, and indicators populated
   - Redis is healthy, agent registration is working
   - No errors or warnings in logs

### Remediation

Deploy the fix from commits `4e53031e`, `b5353e06`, and `094b7da2` (or a single cherry-pick of those three). After deployment, the `getUnifiedConfig()` read path will apply `TechnicalConfigSchema` defaults, populating `scanBatchSize=5` and `scanIntervalMs=60000`. The agents will then:
- Fetch candles in batches of 5 (no more NaN loop skip)
- Run scans every 60 seconds (no more ~1ms tight loop)
- Generate signals → emit wakes → trigger hybrid evaluator → produce trades

No DB migration is required — the fix applies defaults at the DB **read** boundary. Existing agent configs remain unchanged in storage.

---

*Raw data files: `data/01-deployment-identity.txt` through `data/05-candle-ops-evidence.txt`*
