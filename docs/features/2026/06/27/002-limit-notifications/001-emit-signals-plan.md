| Step | What | Files touched |
|------|------|--------------|
| 1 | Add observation-only soft-cap warning in normal path | agent.ts |
| 2 | Add observation-only soft-cap warning in hybrid path | agent.ts |
| 3 | Include open-position context in hard-limit `TICK_SKIPPED` payload (normal path) | agent.ts |
| 4 | Fetch open positions before hard-limit return in hybrid path, include in payload | agent.ts |
| 5 | Add focused integration-style tests for both soft-warning and hard-stop with positions | agent.ts test file or new integration test |
| 6 | Validate with `pnpm lint` and focused test run | — |
| 7 | (Follow-up) Broker-side notification dispatch for billing events | agent-message-broker.ts |