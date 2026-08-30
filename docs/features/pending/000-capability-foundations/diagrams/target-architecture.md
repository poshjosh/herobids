# Target Architecture

Component boundary diagram showing the native messaging capability, the
external trading backend behind a repo-local service boundary, the shared
registry in the domain package, and the ownership-aware visibility predicate
in Agent Core.

## Container Diagram

```mermaid
C4Container
  title Target Architecture — Native Capabilities And External Backends

  Person(user, "User", "Web / Mobile / API consumer")

  Container_Boundary(platform, "OpenAIdom Platform") {

    Container(api, "API (Hono)", "apps/api", "Agent CRUD, capability activation, canonical routes, health")
    Container(web, "Web App", "apps/web", "SPA consuming canonical /capabilities/messaging and /external-backends/trading routes")

    Container_Boundary(agent_core, "Agent Core (apps/worker)") {
      Component(agent_runtime, "Agent Runtime", "agent.ts", "LLM turn loop, protocol, scheduling")
      Component(visibility_predicate, "Visibility Predicate", "ownership-aware", "Ownership + activation + skill + readiness + backend health")
      Component(invocation_client, "External Backend Invocation Client", "external-backends/", "Target selection, HMAC signing, deadline enforcement, retry")
      Component(core_tools, "Core Tools", "tools/memory.ts, filesystem.ts, schema.ts", "get_memory, read_file, write_file, etc.")
      Component(general_tools, "General Tools", "tools/web-access.ts, tasks.ts, code.ts", "search_web, execute_code, etc.")
      Component(messaging_tools, "Messaging Tools", "tools/messaging.ts, email.ts", "send_message, send_email, publish_artifact")
    }

    Container_Boundary(trading_svc, "Trading External Backend (externals/trading)") {
      Component(trading_endpoint, "Invocation Endpoint", "POST /internal/v1/external-tools:invoke", "Validates contract, dispatches to tool handler")
      Component(trading_tools, "Trading Tool Handlers", "All trading-owned tools", "submit_decision, create_bot, get_price, list_positions, ...")
      Component(trading_store, "Invocation Store", "external_tool_invocations", "Idempotency, audit, terminal state")
      Component(trading_health, "Health", "/health/live, /health/ready", "Readiness = config + DB + venue connectivity")
    }

    Container_Boundary(domain_pkg, "Domain Package (packages/domain)") {
      Component(registry, "Capability And Backend Registry", "capability-registry.ts", "NativeCapabilityId, ExternalBackendId, routes, families, providers, lifecycle")
      Component(ownership, "Tool Ownership Manifest", "tool-ownership.ts", "Record<AgentToolName, ToolOwnershipEntry> — exhaustive")
      Component(contract, "External Backend Contract", "external-backend-contract.ts", "Zod schemas: invocation envelope, result, failure codes")
      Component(activation_types, "Activation Types", "capability-activation.ts", "Native activation row shape, resolver predicate inputs")
    }

    ContainerDb(postgres, "PostgreSQL", "Drizzle ORM", "agents, agent_capability_activations, bots, trades, connections, invocations")
    ContainerDb(redis, "Redis", "Cache + pub/sub", "Rate limits, session state, capability-change events")
  }

  System_Ext(venues, "Trading Venues", "Hyperliquid, Jupiter, 1inch, Bybit")
  System_Ext(email_providers, "Email Providers", "Gmail, Yahoo (planned)")
  System_Ext(chat_providers, "Chat Providers", "Telegram, WhatsApp (planned)")
  System_Ext(llm_providers, "LLM Providers", "OpenAI, Anthropic, etc.")

  Rel(user, web, "Uses")
  Rel(web, api, "REST — canonical capability and external-backend routes")
  Rel(api, postgres, "Reads/writes, activation rows")
  Rel(api, redis, "Cache, activation events")

  Rel(agent_runtime, visibility_predicate, "Which tools can the LLM see?")
  Rel(visibility_predicate, registry, "Ownership lookup")
  Rel(visibility_predicate, postgres, "Activation rows")
  Rel(visibility_predicate, trading_svc, "Backend health check")

  Rel(agent_runtime, invocation_client, "Invoke external-backend-owned tool")
  Rel(invocation_client, trading_svc, "HTTPS + HMAC — private network")
  Rel(agent_runtime, core_tools, "Direct in-process dispatch")
  Rel(agent_runtime, general_tools, "Direct in-process dispatch")
  Rel(agent_runtime, messaging_tools, "Direct in-process dispatch (native capability)")

  Rel(trading_tools, venues, "HTTP/WebSocket")
  Rel(trading_tools, postgres, "Trades, positions, bots")
  Rel(messaging_tools, email_providers, "SMTP/API")
  Rel(messaging_tools, chat_providers, "Bot API")
  Rel(agent_runtime, llm_providers, "LLM completions")
  Rel(agent_runtime, redis, "State, streams")
```

## Key Differences From Current State

1. **Agent Core does not import trading implementation.** It dispatches
   external-backend-owned tools through the invocation client over the private
   network. Messaging remains native and in-process.

2. **Trading is an external backend, not a native capability.** It lives under
   `externals/trading/` with its own health endpoints, invocation store, and
   venue connections. A venue outage degrades only the trading backend.

3. **Messaging remains a native capability.** `send_message`, `send_email`,
   and `publish_artifact` execute in-process within Agent Core. Messaging may
   later move to its own package or module, but the platform still owns its
   business semantics.

4. **Visibility is a multi-factor predicate.** Tool visibility requires:
   known tool + requested by skill + exactly one owner + owner state satisfied
   (core/general pass, native capability requires activation, external backend
   requires registration + entitlement + health + readiness) + not excluded by
   runtime policy.

5. **The domain package is the shared contract authority.** Registry, ownership,
   and contract types live in `packages/domain/` — imported by Agent Core and
   external backends. No implementation code crosses these boundaries.

6. **Activation is explicit and durable.** The `agent_capability_activations`
   table stores native capability activation only. External backends do not use
   activation rows; they are dispatchable when registration, entitlement,
   health, and readiness conditions hold.

7. **Routes are canonical and split.** Native capabilities use
   `/capabilities/messaging`. External backends use
   `/external-backends/trading`. The two concepts are not flattened into one
   route family.
