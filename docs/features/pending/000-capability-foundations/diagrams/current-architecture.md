# Current Architecture

Component boundary diagram showing the current monolithic structure where all
tool execution, trading logic, messaging, and visibility decisions live
in-process within the worker.

## Container Diagram

```mermaid
C4Container
  title Current Architecture — All Logic In-Process

  Person(user, "User", "Web / Mobile / API consumer")

  Container_Boundary(platform, "OpenAIdom Platform") {

    Container(api, "API (Hono)", "apps/api", "HTTP API: agent CRUD, capabilities, connections, health")
    Container(web, "Web App", "apps/web", "SPA frontend consuming the API")

    Container_Boundary(worker_boundary, "Worker (apps/worker)") {
      Component(agent_runtime, "Agent Runtime", "agent.ts", "LLM turn loop, protocol, scheduling")
      Component(tool_visibility, "Tool Visibility Controller", "runtime-tool-visibility.ts", "Skill-based visibility, degradation exclusions")
      Component(tool_registry, "Tool Registry", "tools/registry.ts", "All 51 tool implementations registered in-process")
      Component(trading_tools, "Trading Tools", "tools/trading.ts, bots.ts, market-data.ts, ...", "submit_decision, create_bot, get_price, etc.")
      Component(messaging_tools, "Messaging Tools", "tools/messaging.ts, email.ts", "send_message, send_email, publish_artifact")
      Component(general_tools, "General Tools", "tools/web-access.ts, tasks.ts, ...", "search_web, execute_code, etc.")
      Component(core_tools, "Core Tools", "tools/memory.ts, filesystem.ts", "get_memory, read_file, etc.")
    }

    ContainerDb(postgres, "PostgreSQL", "Drizzle ORM", "agents, bots, trades, connections, skills, memories, tasks")
    ContainerDb(redis, "Redis", "Cache + pub/sub", "Rate limits, session state, stream pool")
  }

  System_Ext(venues, "Trading Venues", "Hyperliquid, Jupiter, 1inch, Bybit")
  System_Ext(email_providers, "Email Providers", "Gmail, Yahoo (planned)")
  System_Ext(chat_providers, "Chat Providers", "Telegram, WhatsApp (planned)")
  System_Ext(llm_providers, "LLM Providers", "OpenAI, Anthropic, etc.")

  Rel(user, web, "Uses")
  Rel(web, api, "REST calls")
  Rel(api, postgres, "Reads/writes")
  Rel(api, redis, "Cache")

  Rel(agent_runtime, tool_visibility, "Resolves visible tools")
  Rel(tool_visibility, tool_registry, "Filters by skill requiredTools")
  Rel(tool_registry, trading_tools, "Dispatches")
  Rel(tool_registry, messaging_tools, "Dispatches")
  Rel(tool_registry, general_tools, "Dispatches")
  Rel(tool_registry, core_tools, "Dispatches")

  Rel(trading_tools, venues, "HTTP/WebSocket")
  Rel(trading_tools, postgres, "Trades, positions, bots")
  Rel(messaging_tools, email_providers, "SMTP/API")
  Rel(messaging_tools, chat_providers, "Bot API")
  Rel(agent_runtime, llm_providers, "LLM completions")
  Rel(agent_runtime, postgres, "Sessions, memories")
  Rel(agent_runtime, redis, "State, streams")
```

## Key Observations

1. **Everything is in-process.** Trading tools, messaging tools, and the agent
   runtime share a single Node.js process. A venue timeout or email provider
   failure can degrade the entire worker.

2. **Visibility is skill-only.** The `RuntimeToolVisibilityController` filters
   by skill `requiredTools` and dependency degradation. There is no ownership
   check, no capability activation check, and no service health check.

3. **No formal tool ownership.** Tools are grouped by source file (trading.ts,
   bots.ts, etc.) but no metadata says "this tool belongs to crypto-trading."
   The `TOOL_CATALOG` has categories but categories are display labels, not
   architectural boundaries.

4. **The API capability routes are informational only.** They surface readiness
   and connection state, but tool execution bypasses them entirely.

5. **The domain package is passive.** `packages/domain/` exports types, tool
   names, and skill definitions but has no capability registry, no ownership
   manifest, and no contract types.
