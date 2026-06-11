# Plan: Web Access Tools (`search_web` + `browse_url`)

Feature note: `docs/features/2026/06/10/005-web-access-tools/000-note.md`
Date: 2026-06-10

---

## Overview

Add two `read-web` category tools to the agent runtime:

- **`search_web(query, opts?)`** — searches the internet via Tavily API and returns top results with clean text extracts.
- **`browse_url(url)`** — fetches a URL, validates it (HTTPS-only, no private IPs), and extracts readable text via `@mozilla/readability` + `linkedom`.

Wire a new `research` skill that exposes both tools, so agents can be given research capability selectively.

---

## Dependency Graph

```
Step 1 (domain types)
  → Step 2 (config schema)
    → Step 3 (config defaults + env override)
      → Step 4 (capability policy)
        → Step 5 (tool implementation) ← depends on Step 1, 3, 4
          → Step 6 (tool registration) ← depends on Step 1, 5
            → Step 7 (skill definition) ← depends on Step 1, 6
              → Step 8 (docker env forwarding)
                → Step 9 (tests)
```

---

## Steps

### Step 1 — Add `read-web` category and new tool names to domain types

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `'read-web'` to the `ToolCategory` union (after `'read-market-data'`).

   ```typescript
   | 'read-web'
   ```

   > Follows the existing `<operation>-<target>` format. Both tools are read-only, no side effects.

2. Add `'browse_url'` and `'search_web'` to `KNOWN_AGENT_TOOL_NAMES` (alphabetical order).

   ```typescript
   'browse_url',
   ...
   'search_web',
   ```

> **Risk:** The `assertToolCatalogMatchesRegistry` guard in `apps/worker/src/tools/index.ts` enforces exact parity between `KNOWN_AGENT_TOOL_NAMES` and the tool registry. Entries added here **must** be registered in Step 6 before the worker starts.

---

### Step 2 — Add `webAccess` section to config schema

**File:** `packages/domain/src/config/schema.ts`

Add `WebAccessConfigSchema` (new standalone schema constant) and include it in `AgentRuntimeConfigSchema` (already exists — other tools like `codeExecute` live there), so it flows automatically through `AGENT_RUNTIME_CONFIG_JSON` into the agent container.

```typescript
export const WebAccessToolsConfigSchema = z.object({
  tavily: z.object({
    baseUrl: z.string().url().default('https://api.tavily.com'),
    searchDepth: z.enum(['basic', 'advanced']).default('basic'),
    maxResults: z.number().int().min(1).max(10).default(5),
    timeoutMs: z.number().int().min(1000).default(15_000),
  }).default({}),
  browseUrl: z.object({
    maxResponseBytes: z.number().int().min(1024).default(512 * 1024),   // 512 KB
    timeoutMs: z.number().int().min(1000).default(15_000),
  }).default({}),
});
```

Add to `AgentRuntimeConfigSchema` (inside the existing `tools` sub-object):

```typescript
tools: z.object({
  codeExecute: ...,  // existing
  webAccess: WebAccessToolsConfigSchema.default({}),  // add this
}).default({}),
```

> **Note:** `TAVILY_API_KEY` is a secret — it must never enter the Zod schema. It is forwarded as a plain env var (Step 3, Step 8).

---

### Step 3 — Add config defaults and env override

**File A:** `config/default.yaml`

Inside the existing `agentRuntime.tools` section, add:

```yaml
agentRuntime:
  tools:
    codeExecute:           # existing
      ...
    webAccess:             # add
      tavily:
        baseUrl: "https://api.tavily.com"
        searchDepth: basic
        maxResults: 5
        timeoutMs: 15000
      browseUrl:
        maxResponseBytes: 524288   # 512 KB
        timeoutMs: 15000
```

**File B:** `apps/api/src/config.ts`

Add env override for the Tavily API key — store it under a path that puts it in `agentRuntime` so it flows into `AGENT_RUNTIME_CONFIG_JSON`:

```typescript
TAVILY_API_KEY: { path: 'agentRuntime.tools.webAccess.tavily.apiKey', type: 'string' },
```

> Secrets use env var injection, not config files. `apiKey` must be `z.string().optional()` in the schema so the system starts without it (tools handle missing key gracefully at call time).

---

### Step 4 — Replace `web_fetch` grant with concrete tool grants

**File:** `apps/worker/src/agents/capability-policy.ts`

Remove the existing dead `web_fetch` entry from `DEFAULT_CAPABILITY_GRANTS` — no tool has ever used it. Replace it with two concrete grants:

```typescript
// Remove this:
{
  capability: 'web_fetch',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 30, maxConcurrent: 5, timeoutMs: 30_000, maxResponseBytes: 5 * 1024 * 1024, maxTotalDownloadBytes: 50 * 1024 * 1024 },
},

// Add these:
{
  capability: 'search_web',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 10, maxConcurrent: 3, timeoutMs: 20_000, maxResponseBytes: 256 * 1024 },
},
{
  capability: 'browse_url',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 10, maxConcurrent: 3, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 },
},
```

> Operators can override per-agent via `tool_policy` in the agents table.
> `tier: 'direct'` means no broker round-trip — the agent container calls the external API inline, same as `execute_code`.

---

### Step 5 — Implement the tools

**File:** `apps/worker/src/tools/web-access.ts` *(new file)*

**Dependencies to add (`apps/worker/package.json`):**
- `@mozilla/readability` — HTML content extraction
- `linkedom` — lightweight DOM implementation (no headless browser)

Both are small, pure-Node packages with no native bindings.

#### `web_search` implementation outline

```typescript
const WebSearchParamsSchema = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).optional(),
});

const webSearchTool: AgentTool = {
  name: 'web_search',
  category: 'read-web',
  ...
  async execute(params, ctx): Promise<ToolResult> {
    // 1. Check capability policy (checkAccess('web_search', agentId, sessionId))
    // 2. Read config from AGENT_RUNTIME_CONFIG_JSON → tools.webAccess.tavily
    // 3. Read TAVILY_API_KEY from process.env — return {success: false} if missing
    // 4. POST https://api.tavily.com/search with {api_key, query, search_depth, max_results}
    // 5. Map response to [{title, url, snippet, score}]
    // 6. Truncate combined snippet text to maxResponseBytes from capability grant
    // 7. Record capability start/end, return results as JSON
  },
};
```

Key behaviours:
- If `TAVILY_API_KEY` is absent, return `{ success: false, error: 'web_search requires TAVILY_API_KEY', retryable: false }` — same pattern as `execute_code`.
- Truncate total response payload to `grant.limits.maxResponseBytes ?? config.browseUrl.maxResponseBytes`.
- Use `AbortController` with the configured `timeoutMs`.

#### `browse_url` implementation outline

```typescript
const BrowseUrlParamsSchema = z.object({
  url: z.string().url(),
});

const browseUrlTool: AgentTool = {
  name: 'browse_url',
  category: 'read-web',
  ...
  async execute(params, ctx): Promise<ToolResult> {
    // 1. Check capability policy (checkAccess('browse_url', agentId, sessionId))
    // 2. Validate: must be https:// — reject http://
    // 3. Resolve hostname to IP; reject RFC 1918 / loopback / link-local (SSRF prevention)
    //    Block: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, ::1
    // 4. Fetch with AbortController timeout, stream response, abort if Content-Length > limit
    // 5. Parse HTML with linkedom → extract readable text with @mozilla/readability
    // 6. Truncate extracted text to maxResponseBytes from capability grant / config
    // 7. Return { url, title, content, truncated: boolean }
  },
};
```

Key behaviours:
- Reject non-HTTPS at schema validation level (Zod `z.string().url()` + runtime check for `https:`).
- Perform IP resolution **before** the fetch request and block private ranges — prevents SSRF.
- Cap streamed body at `maxResponseBytes` — do not buffer the full response before checking size.
- Wrap `@mozilla/readability` extraction in try/catch — if parsing fails, return raw text truncated.

Export:

```typescript
export const webAccessTools: AgentTool[] = [webSearchTool, browseUrlTool];
```

---

### Step 6 — Register tools in the factory

**File:** `apps/worker/src/tools/index.ts`

1. Import `webAccessTools`:

   ```typescript
   import { webAccessTools } from './web-access.js';
   ```

2. Add to `allTools` array in `createToolRegistry()`:

   ```typescript
   const allTools = [
     ...messagingTools,
     ...memoryTools,
     ...tradingTools,
     ...botManagementTools,
     ...analyticsTools,
     ...codeTools,
     ...marketDataTools,
     ...priceTools,
     ...watchTools,
     ...webAccessTools,  // add
   ];
   ```

> The `assertToolCatalogMatchesRegistry` guard will verify that the two new names registered here match exactly what was added to `KNOWN_AGENT_TOOL_NAMES` in Step 1.

---

### Step 7 — Define the `research` skill

**File:** `packages/domain/src/skills.ts`

Add `RESEARCH_SKILL` after `PROGRAMMING_SKILL`:

```typescript
export const RESEARCH_SKILL: SkillDefinition = {
  id: 'research',
  name: 'Research',
  description: 'Search the internet and read web pages for research and information gathering.',
  instructions: `You have access to internet research tools.

- Use \`web_search(query)\` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use \`browse_url(url)\` to fetch and read the contents of a specific web page. Only \`https://\` URLs are allowed.
- Use \`send_message\` to share findings with the user.
- Use \`publish_artifact\` when findings are substantial enough to warrant a structured output.`,
  requiredTools: ['web_search', 'browse_url', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};
```

Add to `SYSTEM_SKILLS`:

```typescript
export const SYSTEM_SKILLS: SkillDefinition[] = [
  BOT_MANAGEMENT_SKILL,
  TRADING_SKILL,
  RISK_MONITORING_SKILL,
  PROGRAMMING_SKILL,
  RESEARCH_SKILL,  // add
];
```

> `capabilityFamilies: []` — no trading bindings required. Research skill can be combined freely with any other skill.
> Instructions follow the skill-authoring guide: permissive language ("You have access to…"), not imperative ("Always use…").

---

### Step 8 — Forward `TAVILY_API_KEY` to agent containers

**File:** `apps/worker/src/agents/docker-agent-manager.ts`

Add to the env array alongside other API keys:

```typescript
...(process.env['TAVILY_API_KEY'] ? [`TAVILY_API_KEY=${process.env['TAVILY_API_KEY']}`] : []),
```

Place after the LLM key block. The key is optional at startup; absence is handled gracefully in the tool (Step 5).

---

## Test Strategy

### Unit tests — `apps/worker/src/tools/web-access.test.ts` *(new file)*

All tests mock `fetch` via `vi.stubGlobal` / `vi.spyOn`. No real HTTP calls.

| Test | Assertion |
|------|-----------|
| `web_search` returns structured results | Mock Tavily response; verify title/url/snippet fields |
| `web_search` is denied by capability policy | `checkAccess` returns deny reason; tool returns `{success: false}` |
| `web_search` fails gracefully when `TAVILY_API_KEY` absent | `process.env.TAVILY_API_KEY` = undefined; returns error, `retryable: false` |
| `web_search` truncates oversized response | Capability grant `maxResponseBytes: 100`; verify output length ≤ 100 |
| `browse_url` rejects `http://` URL | Returns `{success: false}` with SSRF/protocol error |
| `browse_url` rejects private IP (e.g. 192.168.1.1) | DNS resolves to private IP; tool blocks before fetch |
| `browse_url` rejects loopback (`127.0.0.1`) | Same as above |
| `browse_url` extracts readable text from valid HTML | Mock `fetch` with sample HTML; verify title + text in response |
| `browse_url` truncates large responses | Capability grant `maxResponseBytes: 256`; verify `truncated: true` |
| `browse_url` is denied by capability policy | Same pattern as `web_search` |

### Registry integrity — existing `apps/worker/src/tools/tool-registry.test.ts`

No changes needed here. The existing `"matches the shared agent tool catalog exactly"` test will pass once Step 1 and Step 6 are complete. If either is done without the other, the test will catch the mismatch.

### Skill integrity — existing `apps/worker/src/tools/tool-registry.test.ts`

The existing `"only exposes known tools from built-in skills"` test will verify `RESEARCH_SKILL.requiredTools` are all in `KNOWN_AGENT_TOOL_NAMES` once Step 7 is complete.

### Integration / manual verification

- Start worker with `TAVILY_API_KEY` set; create an agent with the `research` skill; send a query — verify `web_search` executes and returns results.
- Start worker without `TAVILY_API_KEY`; verify `web_search` returns a clean error without crashing the agent loop.

---

## Open Questions / Risks

1. **DNS resolution for SSRF prevention** — Node's `dns.lookup` resolves to a single IP; does not account for all addresses for a multi-A-record host. Using `dns.resolve` (all addresses) is safer but adds minor latency. Plan uses `dns.resolve` to be conservative.

2. **`@mozilla/readability` in ESM** — The package is CJS-first. Verify import works with `import { Readability } from '@mozilla/readability'` in ESM context; may need `createRequire` wrapper if it ships no ESM export.

3. **Tavily SDK vs. plain `fetch`** — The note recommends Tavily. Since the REST API is a single `POST /search` endpoint, using `fetch` directly avoids adding a vendor SDK dependency. This is preferred per project rules ("Do not add dependencies without justification").

4. **`agentRuntime.tools.webAccess.tavily.apiKey` in config schema** — Adding `apiKey: z.string().optional()` to the Zod schema means it will appear in the serialised `AGENT_RUNTIME_CONFIG_JSON` payload if set via env override. This is acceptable since `AGENT_RUNTIME_CONFIG_JSON` is an internal worker-to-agent transport (not persisted). However, it should not appear in `config/default.yaml` — comment the env override mapping clearly.

---

## Files Changed Summary

| File | Change |
|------|--------|
| `packages/domain/src/tools.ts` | Add `'read-web'` to `ToolCategory`; add `'browse_url'`, `'web_search'` to `KNOWN_AGENT_TOOL_NAMES` |
| `packages/domain/src/config/schema.ts` | Add `WebAccessToolsConfigSchema`; extend `AgentRuntimeConfigSchema.tools` |
| `config/default.yaml` | Add `agentRuntime.tools.webAccess` defaults |
| `apps/api/src/config.ts` | Add `TAVILY_API_KEY` env override |
| `apps/worker/src/agents/capability-policy.ts` | Remove dead `web_fetch` grant; add `web_search` and `browse_url` grants to `DEFAULT_CAPABILITY_GRANTS` |
| `apps/worker/src/tools/web-access.ts` | New file — `web_search` and `browse_url` tool implementations |
| `apps/worker/src/tools/index.ts` | Import and register `webAccessTools` |
| `packages/domain/src/skills.ts` | Add `RESEARCH_SKILL`; add to `SYSTEM_SKILLS` |
| `apps/worker/src/agents/docker-agent-manager.ts` | Forward `TAVILY_API_KEY` to agent containers |
| `apps/worker/package.json` | Add `@mozilla/readability`, `linkedom` |
| `apps/worker/src/tools/web-access.test.ts` | New file — unit tests |
