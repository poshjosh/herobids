
# ALWAYS ON DISCOVERY COORDINATOR MONITOR - Q AND A

The main design questions are:

1. Should this live in the worker or a separate process?
Recommended answer: worker first.

The worker already owns long-running orchestration in runtime.ts and startup composition in index.ts. It already has Redis, DB, event publishing, market-data config, and agent supervision. That makes it the cheapest correct home for a first version.

The right shape is not “misc logic in the worker main file.” It should be worker-embedded but modular, with one leader-elected active coordinator per deployment. If it later needs independent scaling or isolation, then split it into its own process.

2. Is this still a top priority with the newer agent-tick architecture?
Recommended answer: important, but not absolute top priority.

Herobids already has richer autonomous ticks than the old repo. The agent runtime pulls discovery and regime context during ticks in agent.ts, and provider coordination/caching already exists in provider-registry.ts. So this is no longer a “missing foundation” problem.

It is now a latency, eventing, and platform-state problem. That still matters, especially for DEX discovery and token watches, but it is more of a P2 systems epic than a P0 unblocker. I would prioritize it after high-leverage strategy-quality and DEX-safety work, but ahead of heavier orchestration work.

3. What should the system actually do that it does not do now?
Recommended answer: three things.

It should continuously refresh shared market opportunity state.  
It should evaluate watches and monitor conditions outside the agent tick.  
It should push events or wake signals to agents when something meaningful happens.

Today, watches in watch.ts are persisted state plus an on-demand evaluator. The agent only learns a watch fired when it later calls `check_watches`. That is the exact behavior this epic should change.

4. Should the coordinator make decisions?
Recommended answer: no.

The coordinator and monitor should observe, classify, store, and notify. Agents still decide. That preserves agent-mode purity and keeps policy in the agent goal rather than the platform.

5. Should watch definitions remain Redis-backed only, or become durable DB records with Redis as the hot index?

Recommended answer: Redis first if you want speed, DB later if watch durability across infra failures becomes important.

6. Should v1 wake the agent immediately or just schedule the next tick sooner?

Recommended answer: schedule an early bounded tick, not an uncontrolled interrupt.

7. Which monitor classes belong in v1?

Recommended answer: price thresholds first, discovery delta second, regime-change third.

8. Should market events go through existing instance-to-agent streams or a dedicated market-event channel?

Recommended answer: reuse the current agent message path first unless volume proves it too noisy.
