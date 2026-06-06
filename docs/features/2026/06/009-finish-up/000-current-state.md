## Current State

The codebase is substantially ahead of the plan documentation. Phases 1–4 are all in various states of completion after a catch-up audit on 2026-06-05. The actual open work is:

**Phase 1 — 5 items remaining (foundation cleanup)**
| | Item | Blocked by |
|---|---|---|
| R1.1 | Rename `TradingInstanceId`/`TradingInstanceConfig*` → `BotId`/`BotConfig*` in domain | nothing |
| R1.2 | Rename `instances.ts` API route → `bots.ts` + update web client | nothing |
| R1.3 | Create `/bots` web page with strategy preset UI | R1.2 |
| R1.4 | Wire `paused_by_guardrail` + `critical_execution_failure` safety alerts | nothing |
| R1.5 | Delete control in `AgentDetailPage` | nothing |

**Phase 2 — 2 items remaining (real runtime)**
| | Item | Blocked by |
|---|---|---|
| R2.1 | Set `AGENT_RUNTIME_MODE=docker` + `AGENT_IMAGE` in docker-compose.yaml | nothing |
| R2.2 | Re-assess SandboxEnforcer on `code_execute` — agent.ts already handles this locally in-container (check if the TODO is stale) | nothing |

**Phase 3 — 1 item remaining**
| | Item | Blocked by |
|---|---|---|
| R3.2 | Verify/complete progress context (P&L, score, bot statuses) injected into agent prompt tick | nothing |

**Cross-cutting (from TODO.md)**
- Stale capability cache — broker caches `CapabilityPolicyEngine` by agent ID and never invalidates; `PATCH` on `skillIds`/`toolPolicy` silently has no effect until worker restart
- Plan quota TOCTOU — known race condition in plan guard checks (all `checkXxxLimit` + insert sequences are non-atomic)

---

## Proposal

I'd suggest tackling in this order:

**Batch 1 — Clear the Phase 1 backlog (unblocks Phase 3)**
Do R1.1, R1.2, R1.4, R1.5 in parallel (no dependencies). Then R1.3 (which needs R1.2). These are mechanical but important for naming consistency and the safety correctness of the platform.

**Batch 2 — Activate the real runtime**
R2.1 is a one-liner in docker-compose.yaml. R2.2 needs a quick check — the `code_execute` path in agent.ts already uses `sandbox-exec.sh` and `capabilityEngine.checkAccess()`; the broker may never need a handler for it since code execution runs in-container. The TODO may be stale.

**Batch 3 — Complete Phase 3**
R3.2: verify/complete progress context in the agent's LLM tick. This is the experience-quality item that makes agents actually useful at tracking their own performance.

**Batch 4 — Fix the stale capability cache**
This is a correctness bug in production: once an agent runs, permission changes have no effect. Fix requires invalidating the cached `CapabilityPolicyEngine` in the broker when `skillIds`/`toolPolicy` 