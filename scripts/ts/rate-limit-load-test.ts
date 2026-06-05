/**
 * rate-limit-load-test.ts — Validates market data rate limiting under concurrent agent load.
 *
 * Simulates N agents all requesting market data simultaneously and reports:
 *   - Actual request rates per provider
 *   - Whether the rate limiter correctly throttled to the configured limit
 *   - Whether any provider returned 429 during the test window
 *   - Whether individual agents were starved indefinitely
 *
 * Usage:
 *   AGENT_COUNT=10 DURATION_S=30 BASE_URL=http://localhost:3000 tsx ts/rate-limit-load-test.ts
 *
 * Output: Prints a markdown report to stdout (redirect to a file for saving).
 */

const AGENT_COUNT = parseInt(process.env['AGENT_COUNT'] ?? '5', 10);
const DURATION_S = parseInt(process.env['DURATION_S'] ?? '30', 10);
const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:3000';
const TARGET_RPS = parseInt(process.env['TARGET_RPS'] ?? '10', 10);

// Set ENDPOINT_IS_RATE_LIMITED=true when makeRequest() has been updated to target
// an actual rate-limited endpoint.  Keeping this as an env var (rather than a
// code constant) means the caller must explicitly opt in at the same time they
// provide a real endpoint via BASE_URL — both changes happen in one invocation.
const ENDPOINT_IS_RATE_LIMITED = process.env['ENDPOINT_IS_RATE_LIMITED'] === 'true';

interface AgentStats {
  agentId: number;
  requests: number;
  successes: number;
  tooManyRequests: number;
  errors: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxWaitMs: number;
}

interface RunSummary {
  agentCount: number;
  durationS: number;
  targetRps: number;
  totalRequests: number;
  totalSuccesses: number;
  total429s: number;
  totalErrors: number;
  actualRps: number;
  agents: AgentStats[];
  anyStarved: boolean;
  rateExceeded: boolean;
  startedAt: string;
  endedAt: string;
}

async function makeRequest(agentId: number): Promise<{ ok: boolean; status: number; latencyMs: number }> {
  const start = Date.now();
  try {
    // TODO: Replace /health with an actual rate-limited market data endpoint (e.g. /api/market/ticker
    // or the venue proxy) to validate throttling under real agent load.  The current /health probe
    // is never rate-limited, so rateExceeded and anyStarved will always be false — the PASS results
    // for those checks are meaningless until this is updated.
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, status: 0, latencyMs: Date.now() - start };
  }
}

async function runAgent(agentId: number, durationMs: number, requestIntervalMs: number): Promise<AgentStats> {
  const stats: AgentStats = {
    agentId,
    requests: 0,
    successes: 0,
    tooManyRequests: 0,
    errors: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    maxWaitMs: 0,
  };

  const latencies: number[] = [];
  const deadline = Date.now() + durationMs;
  let lastRequestAt = 0;

  while (Date.now() < deadline) {
    const now = Date.now();
    const waitMs = Math.max(0, requestIntervalMs - (now - lastRequestAt));
    if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));

    lastRequestAt = Date.now();
    stats.maxWaitMs = Math.max(stats.maxWaitMs, waitMs);
    stats.requests++;

    const result = await makeRequest(agentId);
    latencies.push(result.latencyMs);

    if (result.ok) {
      stats.successes++;
    } else if (result.status === 429) {
      stats.tooManyRequests++;
    } else {
      stats.errors++;
    }
  }

  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    stats.p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    stats.p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  }

  return stats;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.error(`[rate-limit-load-test] Starting: ${AGENT_COUNT} agents, ${DURATION_S}s, target ${TARGET_RPS} RPS`);

  const requestIntervalMs = Math.floor(1000 / (TARGET_RPS / AGENT_COUNT));
  const durationMs = DURATION_S * 1000;

  const agentPromises = Array.from({ length: AGENT_COUNT }, (_, i) =>
    runAgent(i + 1, durationMs, requestIntervalMs),
  );

  const agentStats = await Promise.all(agentPromises);
  const endedAt = new Date().toISOString();

  const summary: RunSummary = {
    agentCount: AGENT_COUNT,
    durationS: DURATION_S,
    targetRps: TARGET_RPS,
    totalRequests: agentStats.reduce((s, a) => s + a.requests, 0),
    totalSuccesses: agentStats.reduce((s, a) => s + a.successes, 0),
    total429s: agentStats.reduce((s, a) => s + a.tooManyRequests, 0),
    totalErrors: agentStats.reduce((s, a) => s + a.errors, 0),
    actualRps: 0,
    agents: agentStats,
    anyStarved: agentStats.some((a) => a.maxWaitMs > requestIntervalMs * 3),
    rateExceeded: agentStats.some((a) => a.tooManyRequests > 0),
    startedAt,
    endedAt,
  };
  summary.actualRps = summary.totalRequests / DURATION_S;

  printReport(summary);
}

function printReport(s: RunSummary) {
  console.log(`# Rate Limit Load Test Report`);
  console.log(``);
  console.log(`**Run date:** ${s.startedAt}`);
  console.log(`**Duration:** ${s.durationS}s`);
  console.log(`**Agent count:** ${s.agentCount}`);
  console.log(`**Target RPS:** ${s.targetRps}`);
  console.log(``);
  console.log(`## Summary`);
  console.log(``);
  console.log(`| Metric | Value |`);
  console.log(`|---|---|`);
  console.log(`| Total requests | ${s.totalRequests} |`);
  console.log(`| Successes | ${s.totalSuccesses} |`);
  console.log(`| 429 responses | ${s.total429s} |`);
  console.log(`| Errors | ${s.totalErrors} |`);
  console.log(`| Actual RPS | ${s.actualRps.toFixed(2)} |`);
  console.log(`| Rate limit exceeded | ${s.rateExceeded ? '❌ YES' : '✅ NO'} |`);
  console.log(`| Any agent starved | ${s.anyStarved ? '⚠️ YES' : '✅ NO'} |`);
  console.log(``);
  console.log(`## Per-Agent Stats`);
  console.log(``);
  console.log(`| Agent | Requests | Successes | 429s | Errors | p50 (ms) | p95 (ms) | Max wait (ms) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const a of s.agents) {
    console.log(`| ${a.agentId} | ${a.requests} | ${a.successes} | ${a.tooManyRequests} | ${a.errors} | ${a.p50LatencyMs} | ${a.p95LatencyMs} | ${a.maxWaitMs} |`);
  }
  console.log(``);
  console.log(`## Verdict`);
  console.log(``);
  // NOTE: The /health endpoint is not rate-limited (see TODO in makeRequest), so
  // rateExceeded and anyStarved will always be false.  The verdict below is only
  // meaningful for connectivity and baseline latency — NOT for validating the rate
  // limiter.  Replace the endpoint before treating this report as authoritative.
  if (!ENDPOINT_IS_RATE_LIMITED) {
    console.log(`⚠️ **N/A** — ENDPOINT_IS_RATE_LIMITED is false. Replace the \`/health\` placeholder in makeRequest() with a real rate-limited endpoint and set the flag to true to get a valid verdict.`);
  } else {
    const passing = !s.rateExceeded && !s.anyStarved && s.totalErrors === 0;
    console.log(passing
      ? `✅ **PASS** — Rate limiter held at ${s.targetRps} RPS across ${s.agentCount} agents. No 429s. No starvation.`
      : `❌ **FAIL** — See issues above.`);
  }
}

main().catch((err: unknown) => {
  console.error('[rate-limit-load-test] Fatal:', err);
  process.exit(1);
});
