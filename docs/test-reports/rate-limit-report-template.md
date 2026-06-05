# Rate Limit Load Test Report Template

Copy this file for each test run:
```
cp docs/test-reports/rate-limit-report-template.md docs/test-reports/rate-limit-YYYY-MM-DD-N-agents.md
```

Or generate a report directly from the script:
```bash
AGENT_COUNT=10 DURATION_S=30 BASE_URL=http://localhost:3000 \
  pnpm --filter @herobids/scripts run rate-limit-load-test \
  > docs/test-reports/rate-limit-$(date +%Y-%m-%d)-10-agents.md
```

---

# Rate Limit Load Test Report

**Run date:** <!-- YYYY-MM-DDTHH:mm:ssZ -->
**Duration:** <!-- e.g. 30s -->
**Agent count:** <!-- e.g. 10 -->
**Target RPS:** <!-- e.g. 10 -->
**Environment:** <!-- local | staging | production -->
**Run by:** <!-- name or CI job -->

## Summary

| Metric | Value |
|---|---|
| Total requests | |
| Successes | |
| 429 responses | |
| Errors | |
| Actual RPS | |
| Rate limit exceeded | ✅ NO / ❌ YES |
| Any agent starved | ✅ NO / ⚠️ YES |

## Per-Agent Stats

| Agent | Requests | Successes | 429s | Errors | p50 (ms) | p95 (ms) | Max wait (ms) |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| … | | | | | | | |

## Verdict

<!-- ✅ PASS — Rate limiter held at N RPS across M agents. No 429s. No starvation. -->
<!-- ❌ FAIL — See issues above. -->

## Notes

<!-- Add observations, config changes, or follow-up actions here. -->
