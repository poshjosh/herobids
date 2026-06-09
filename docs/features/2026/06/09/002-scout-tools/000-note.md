# Scout tools

**scout/judge is 85% complete but missing a key piece**. Here's what needs to be finished:

## Current State

✅ **Working:**
- Scout uses cheap model (`scoutModel` field in cost profile)
- Scout returns `hold`/`escalate` disposition
- Hold ends tick without judge call
- Escalate passes reason to judge via user context
- Escalation rate is tracked and logged
- Judge gets full context + scout's reason
- Cost tracking for both phases

❌ **Missing:** Scout has NO tools (neither read nor write)

## The Problem

The design doc says scout should have **"read-only tools"** like `check_regime`, `list_positions`, `search_tokens` (in the case of trading related skills) so it can make informed triage decisions. Currently:

```typescript
// Scout call (line 1543-1562)
{
  messages: [
    { role: 'system', content: scoutSystemPrompt },
    { role: 'user', content: userContext },
  ],
  // ❌ NO tools: parameter — scout can't call anything
}
```

The scout is just doing text-in/text-out reasoning with no ability to check positions or regime, making it essentially a "guess whether to escalate" rather than an informed triage.

## What Needs To Be Done

### T8 Completion: Give Scout Read-Only Tool Access

**Files:** agent.ts

1. **Pass tools to scout LLM call:**

```typescript
// Around line 1543
const scoutResultWithRetry = await callLlmWithRetry(
  {
    provider: LLM_PROVIDER!,
    model: agentConfig.scoutModel ?? resolveDefaultScoutModel(LLM_PROVIDER!, LLM_MODEL),
    maxTokens: 256,
    timeoutMs: LLM_TIMEOUT_MS,
    baseUrl: LLM_BASE_URL,
  },
  {
    messages: [
      { role: 'system', content: scoutSystemPrompt },
      { role: 'user', content: userContext },
    ],
    maxTokens: 256,
    temperature: 0,
    thinking: 'none',
    tools: readOnlyScoutTools,  // ✅ ADD THIS — pass tool schemas
  },
  // ...
);
```

2. **Handle scout tool calls:**

```typescript
// After scout returns (line ~1566)
if (scoutResult.ok) {
  recordSessionCost(/* ... */);
  
  // ✅ ADD: Parse and execute tool calls from scout
  const scoutToolCalls = parseToolCalls(scoutResult.data.content);
  for (const call of scoutToolCalls) {
    // Reject write tools if scout somehow calls them (defense in depth)
    if (!readOnlyScoutTools.includes(call.tool)) {
      logger.warn({ tool: call.tool, phase: 'scout' }, 'Scout attempted write tool — rejecting');
      continue;
    }
    
    try {
      const toolResult = await executeTool(call);
      if (toolResult) {
        // Append tool result to scout's context for final disposition decision
        // Or trigger a follow-up scout call with tool results
      }
    } catch (err) {
      logger.warn({ err, tool: call.tool, phase: 'scout' }, 'Scout tool execution failed');
    }
  }
}

const scoutDecision = parseScoutDecision(scoutResult.data.content);
// ... rest of logic
```

### Alternative: Multi-Turn Scout

If you want scout to make multiple tool calls before deciding:

```typescript
// Scout loop (up to 3 turns)
let scoutMessages = [
  { role: 'system', content: scoutSystemPrompt },
  { role: 'user', content: userContext },
];

for (let turn = 0; turn < 3; turn++) {
  const scoutResult = await callLlmWithRetry(/* ... */, {
    messages: scoutMessages,
    tools: readOnlyScoutToolSchemas,
  });
  
  const toolCalls = parseToolCalls(scoutResult.data.content);
  if (toolCalls.length === 0) break; // No more tools needed
  
  for (const call of toolCalls) {
    const result = await executeTool(call);
    scoutMessages.push({
      role: 'assistant',
      content: scoutResult.data.content,
      tool_calls: toolCalls,
    });
    scoutMessages.push({
      role: 'tool',
      content: result,
      tool_call_id: call.id,
    });
  }
}

// Final scout call for disposition
const finalScout = await callLlmWithRetry(/* ... */, {
  messages: [...scoutMessages, {
    role: 'user',
    content: 'Based on the tool results, should I escalate to the judge?'
  }],
  tools: [], // No more tools, just decide
});
```

### T9 Completion: Already Done ✅

Judge escalation is fully implemented:
- Judge receives scout reason (line 1597)
- Judge uses premium model with thinking levels
- Escalation rate is logged  
- Metrics exist for tuning

## Recommendation

**Start with multi-turn scout**
1. Scout gets tool schemas
2. Scout makes at most N tool calls. N is configurable
3. Tool result is appended to context
4. Scout then decides hold/escalate

This matches the "compact prompt" design while still allowing informed decisions. Multi-turn can be added later if needed.