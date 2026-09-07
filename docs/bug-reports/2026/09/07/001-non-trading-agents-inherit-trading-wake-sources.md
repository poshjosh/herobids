# Bug Report: non-trading agents are subscribed to trading wake sources (`watch_threshold`, `discovery_delta`, `regime_change`)

- **Status:** OPEN (not yet fixed — investigation only)
- **Severity:** Medium (no incorrect trades — non-trading agents cannot act on the events — but causes constant irrelevant wake context, LLM token cost, and noise; also degrades agent focus)
- **Date:** 2026-09-07
- **Discovered By:** Investigating why personal-property-locator agent `finder-1` (`d3da3d1f-404b-491b-ad67-65d154b6fdca`, local dev) never sent its requested report. Its outbound event stream was flooded with `market.discovery.detected` (crypto) events despite being a bicycle-finder with no trading skill.
- **Summary:** An agent's `wakePreferences.subscribedSources` determines which market-monitor events the worker fans out to it. The agent create/edit UI hardcodes the three **trading** wake sources (`watch_threshold`, `discovery_delta`, `regime_change`) into every agent regardless of skill preset, and re-applies them on any `style` change. Selecting a non-trading preset (e.g. "Personal assistant") never clears them. These preferences are then persisted to the agent, propagated into any blueprint authored from the agent, and copied verbatim into every agent instantiated from that blueprint. Result: a personal-assistant/finder agent receives a continuous stream of crypto discovery events it has no skill to act on.

## Impact

For `finder-1`, the outbound stream (`agent:outbound:<id>`) contained thousands of `market.discovery.detected` events (`monitorType: discovery_delta`, Base/Solana tokens). This agent has only `herobids/personal-property-locator-tool-referencing` plus base/system skills — no trading capability. Every such event is:

- irrelevant wake/context material rendered into the tick prompt (see "Discovery Trigger Context" provider),
- billable LLM input tokens for a non-trading agent,
- additional distraction competing with the agent's actual job.

No safety impact (the agent cannot place trades), so severity is Medium not High.

## Steps to Reproduce

1. In the create-agent UI, choose skill preset **Personal assistant** (or **Custom** with only non-trading skills).
2. Leave/adjust **style** (balanced/aggressive/etc.).
3. Create the agent, then inspect:
   - DB: `SELECT wake_preferences FROM agents WHERE id = '<id>';`
   - Redis (while running): `GET agent:wake:prefs:<id>`
4. **Observed:** `{"subscribedSources":["watch_threshold","discovery_delta","regime_change"]}` — the trading sources, on a non-trading agent.
5. **Expected:** a non-trading agent defaults to non-trading sources only (e.g. `["reminder"]`, or an empty set), and never `discovery_delta` / `watch_threshold` / `regime_change` unless it has a trading capability.

Observed values for the real agent:

```
agents.wake_preferences = {"subscribedSources": ["watch_threshold", "discovery_delta", "regime_change"]}
agents.style           = balanced
agent:wake:prefs:d3da3d1f-... = {"subscribedSources":["watch_threshold","discovery_delta","regime_change"]}
agent skills           = system/{browser,email,file-management,programming,task-management,web-access},
                         herobids/personal-property-locator-tool-referencing   (no trading skill)
```

## Root Cause

The create/edit UI treats trading wake sources as the universal default and couples them to the (trading-only) `style` control, with no dependency on skill preset / capability family.

`apps/web/src/features/agents/AgentsPage.tsx`:
- Initial intent state hardcodes the trading sources (~line 331):
  ```ts
  subscribedSources: ['watch_threshold', 'discovery_delta', 'regime_change'],
  ```
- The **skill-preset** `onChange` (~lines 816–834) updates `skillIds`, `authorizationMode`, and clears trading sessions — but **does not touch `subscribedSources`**. Switching to "Personal assistant" leaves the trading sources in place.
- The **style** `onChange` (~lines 906–918) unconditionally resets `subscribedSources` to the trading set (plus `scanner` when technical pre-filter is on):
  ```ts
  const tradingSources = ['watch_threshold', 'discovery_delta', 'regime_change'];
  const styleSources = state.technicalPreFilterEnabled ? [...tradingSources, 'scanner'] : tradingSources;
  // ...
  subscribedSources: styleSources,
  ```

`apps/web/src/features/agents/EditAgentModal.tsx` (~lines 654–673) has the **identical** style-onChange reset, so editing an agent and touching the style dropdown re-adds `discovery_delta` even if it had been removed.

### Propagation chain (why it persists and spreads)

1. **Create → persist:** UI posts `wakePreferences` → `apps/api/src/routes/agents.ts` (~line 609) persists it to `agents.wake_preferences`; PATCH (~line 1666) also syncs `agent:wake:prefs:<id>` in Redis immediately.
2. **Author blueprint from agent:** `apps/api/src/services/blueprint-projection.ts` (~line 57) copies `agent.wakePreferences` into the blueprint revision payload.
3. **Instantiate agent from blueprint:** `apps/api/src/services/agent-instantiation-service.ts` (~line 129) copies `payload.wakePreferences` verbatim into the new agent. (This is exactly how `finder-1` — blueprint `e14a8d06-...`, revision `a2418790-...` — got the trading sources.)

### Delivery (why the flood happens)

`apps/worker/src/market-intelligence/monitor.ts`:
- `getSubscribedActiveAgents(source)` (~line 962) selects an agent when it has **no** prefs key (treated as "all sources") **or** `subscribedSources.includes(source)` (~line 987).
- The discovery paths (`emitMarketDiscoveryDetected`, ~lines 462 / 522 / 589) then emit to each subscribed agent (rate-limited per agent).

So any agent whose `subscribedSources` contains `discovery_delta` receives every discovery event — which is precisely what happened.

## Proposed direction (NOT yet applied — decision pending)

The user intends to update prompts separately; this report captures the config-modeling defect.

Preferred: **derive wake-source defaults from capability, not from `style`.**

1. Default `subscribedSources` from the selected skill preset / capability family:
   - trading presets (`trading`, `direct-trading`, `trading-assistant`, or any skill with the `trading` capability family) → the trading set (+`scanner` when technical pre-filter is on);
   - non-trading presets (`personal-assistant`, non-trading `custom`) → `['reminder']` (or empty).
2. In **both** create (`AgentsPage.tsx`) and edit (`EditAgentModal.tsx`) `style` `onChange`, stop unconditionally overwriting `subscribedSources`. Only apply trading-source defaults when the agent has a trading capability, and otherwise preserve the user's explicit selection.
3. When the **skill preset** changes to a non-trading preset, prune trading-only sources (`watch_threshold`, `discovery_delta`, `regime_change`, `scanner`) from `subscribedSources`.
4. Defense-in-depth (optional, server-side): in `monitor.ts` fan-out, skip agents that lack a trading capability so a stale/bad pref cannot flood a non-trading agent even if the UI regresses again.

Note: the worker's "no prefs key ⇒ all sources" default (`monitor.ts` ~line 987) is a separate sharp edge — a non-trading agent with `wake_preferences = null` would also receive everything. Consider making "all sources" capability-scoped too.

## Verification (for whoever fixes this)

| Check | How |
|-------|-----|
| Non-trading create defaults | Create a Personal-assistant agent → DB `wake_preferences` excludes `discovery_delta`/`watch_threshold`/`regime_change` |
| Style change preserves non-trading | On a non-trading agent, change `style` → trading sources are NOT injected |
| Preset switch prunes trading sources | Switch preset trading → personal-assistant → trading sources removed from `subscribedSources` |
| Trading agents unaffected | Trading preset still defaults to the trading set (+`scanner` with technical pre-filter) |
| Blueprint round-trip | Author blueprint from a non-trading agent, instantiate it → new agent has no trading wake sources |
| Worker fan-out | Non-trading agent does not appear in `getSubscribedActiveAgents('discovery_delta')` |
| `pnpm lint` passes | tsc `--noEmit` clean |

## References

- `apps/web/src/features/agents/AgentsPage.tsx` — initial `subscribedSources` (~line 331); skill-preset `onChange` (~lines 816–834, no source update); style `onChange` reset (~lines 906–918)
- `apps/web/src/features/agents/EditAgentModal.tsx` — style `onChange` reset (~lines 654–673)
- `apps/web/src/features/agents/WakeSourceSection.tsx` — wake source option list (`discovery_delta` = "Discovery Deltas — Newly trending tokens")
- `apps/api/src/routes/agents.ts` — persist `wakePreferences` (~line 609); PATCH Redis sync (~lines 1666–1674)
- `apps/api/src/services/blueprint-projection.ts` — copies agent `wakePreferences` into blueprint payload (~line 57)
- `apps/api/src/services/agent-instantiation-service.ts` — copies blueprint `wakePreferences` into new agent (~line 129)
- `apps/worker/src/market-intelligence/monitor.ts` — `getSubscribedActiveAgents` (~line 962), pref check (~line 987), discovery emit (~lines 462/522/589)
- `apps/worker/src/agents/agent-session-manager.ts` — writes `agent:wake:prefs:<id>` from `wake_preferences` on session start/recovery (~lines 201, 842)
- `apps/worker/src/runtime-composition.ts` — `RuntimeMarketWakeContext.source` union incl. `discovery_delta` (~line 60); discovery-trigger-context provider

## Related

- `docs/bug-reports/2026/09/04/004-scanner-gated-agent-create-overwrites-technical-filters.md` — same area (agent-create UI/normalization clobbering user-owned config that the client did not intend to change).
