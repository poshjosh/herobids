# BUG MISMATCH BETWEEN AGENT AND RUNTIME - Q AND A
## Prompt 1
Investigate this ### False "crashed" Status After Graceful Shutdown (Bug)

noted in this report .ignore/eval/2026/06/11/949d8daf-246a-4426-b637-11b98b5eae71/002/REPORT.md

Investigate and advise.

## Response 1

**Findings**
The report’s specific claim about a delayed Docker die event overwriting a graceful stop is not accurate against the current source.

- Current code explicitly protects voluntary stops in docker-agent-manager.ts. The die handler returns early when the agent is already marked stopped.
- Current code also has a dedicated session-ended path in agent-message-broker.ts whose comment says it exists specifically so Docker die handling sees status stopped and skips the crash path.

What is still real is a different inconsistency.

- The runtime shutdown path in agent.ts always emits a session-ended message with a reason code.
- In agent-message-broker.ts, only a small set of reason codes are treated as planned. Anything else, including the report’s "tool.failed", is intentionally mapped to agent status "crashed".
- But that same broker path then retires active runtime sessions via agent-repository.ts, and that helper always marks sessions as "stopped", not "crashed".
- The activity mapper in agent-activity-mapper.ts interprets session status "stopped" as a graceful shutdown.

So the current bug is not mainly "false crashed status after graceful shutdown". It is:

- agent terminal state says "crashed"
- runtime session terminal state says "stopped"
- UI/activity feed therefore describes the same shutdown as graceful

That mismatch is enough to make the report read like a false crash, even when the code is deliberately treating the shutdown as abnormal.

There is one more live issue.

- If the runtime self-classifies as crashed first, the later Docker die event in docker-agent-manager.ts will not skip, because it only skips when agent status is "stopped".
- That means an abnormal but orderly self-shutdown can still go through crash handling twice: once via session-ended classification, and again via delayed Docker die detection. The final status is the same, but the logs and alerts can be duplicated or misleading.

**Advice**
I would not describe this as a graceful-stop overwrite bug anymore. I would describe it as a terminal-state modeling bug plus a duplicate crash-handling risk.

Recommended direction:

1. Keep agent status "crashed" for unplanned self-shutdown reasons such as "tool.failed". That is the correct high-level classification.
2. Stop using a helper that always retires sessions to "stopped" for those paths. Add a status-aware retirement path so abnormal session-ended handling can mark runtime sessions as "crashed".
3. Update the activity mapper so session status "crashed" renders as failed and session status "stopped" renders as graceful only when that is actually true.
4. Make Docker die handling idempotent for already-terminal abnormal shutdowns. A practical guard is: if there is no active runtime session left, or if the latest terminal transition already came from session-ended handling, skip duplicate crash alerting.
5. Update the report wording and any follow-up docs. The current misleading symptom is "agent crashed while session looked gracefully stopped", not "Docker overwrote a graceful stop to crashed".