# Target Architecture

Component boundary diagram showing the extracted capability services, shared
registry in the domain package, and the capability-aware visibility predicate
in Agent Core.

## Container Diagram

```mermaid
C4Container
  title Target Architecture — Extracted Capability Services

  Person(user, "User", "Web / Mobile / API consumer")

  Container_Boundary(platform, "OpenAIdom Platform") {

    Container(api, "API (Hono)", "apps/api", "Agent CRUD, capability activation, canonical routes, health")
    Container(web, "Web App", "apps/web", "SPA consuming canonical /capabilities/crypto-trading and /capabilities/messaging routes")

    Container_Boundary(agent_core, "Agent Core (apps/worker)") {
      Component(agent_runtime, "Agent Runtime", "agent.ts", "LLM turn loop, protocol, scheduling")
      Component(visibility_predicate, "Visibility Predicate", "capability-aware", "Ownership + activation + skill + readiness + service health")
      Component(invocation_client, "Capability Invocation Client", "capability-invocation/", "Target selection, HMAC signing, deadline enforcement, retry")
      Component(core_tools, "Core Tools", "tools/memory.ts, filesystem.ts, schema.ts", "get_memory, read_file, write_file, etc.")
      Component(general_tools, "General Tools", "tools/web-access.ts, tasks.ts, code.ts", "search_web, execute_code, etc.")
    }

    Container_Boundary(crypto_trading_svc, "Crypto-Trading Service (apps/crypto-trading)") {
      Component(trading_endpoint, "Invocation Endpoint", "POST /internal/v1/capability-tools:invoke", "Validates contract, dispatches to tool handler")
      Component(trading_tools, "Trading Tool Handlers", "All crypto-trading-owned tools", "submit_decision, create_bot, get_price, list_positions, ...")
      Component(trading_store, "Invocation Store", "capability_tool_invocations", "Idempotency, audit, terminal state")
      Component(trading_health, "Health", "/health/live, /health/ready", "Readiness = config + DB + venue connectivity")
    }

    Container_Boundary(messaging_svc, "Messaging Service (apps/messaging)") {
      Component(messaging_endpoint, "Invocation Endpoint", "POST /internal/v1/capability-tools:invoke", "Validates contract, dispatches to tool handler")
      Component(messaging_tools, "Messaging Tool Handlers", "All messaging-owned tools", "send_message, send_email, publish_artifact")
      Component(messaging_store, "Invocation Store", "capability_tool_invocations", "Idempotency, delivery state")
      Component(messaging_health, "Health", "/health/live, /health/ready", "Readiness = config + providers")
    }

    Container_Boundary(domain_pkg, "Domain Package (packages/domain)") {
      Component(registry, "Capability Registry", "capability-registry.ts", "ProductCapabilityId, routes, aliases, families, providers, lifecycle")
      Component(ownership, "Tool Ownership Manifest", "tool-ownership.ts", "Record<AgentToolName, ToolOwnershipEntry> — exhaustive")
      Component(contract, "Capability-Tool Contract", "capability-tool-contract.ts", "Zod schemas: invocation envelope, result, failure codes")
      Component(activation_types, "Activation Types", "capability-activation.ts", "Activation row shape, resolver predicate inputs")
    }

    ContainerDb(postgres, "PostgreSQL", "Drizzle ORM", "agents, agent_capability_activations, bots, trades, connections, invocations")
    ContainerDb(redis, "Redis", "Cache + pub/sub", "Rate limits, session state, capability-change events")
  }

  System_Ext(venues, "Trading Venues", "Hyperliquid, Jupiter, 1inch, Bybit")
  System_Ext(email_providers, "Email Providers", "Gmail, Yahoo (planned)")
  System_Ext(chat_providers, "Chat Providers", "Telegram, WhatsApp (planned)")
  System_Ext(llm_providers, "LLM Providers", "OpenAI, Anthropic, etc.")

  Rel(user, web, "Uses")
  Rel(web, api, "REST — canonical capability routes")
  Rel(api, postgres, "Reads/writes, activation rows")
  Rel(api, redis, "Cache, activation events")

  Rel(agent_runtime, visibility_predicate, "Which tools can the LLM see?")
  Rel(visibility_predicate, registry, "Ownership lookup")
  Rel(visibility_predicate, postgres, "Activation rows")
  Rel(visibility_predicate, crypto_trading_svc, "Service health check")
  Rel(visibility_predicate, messaging_svc, "Service health check")

  Rel(agent_runtime, invocation_client, "Invoke capability-owned tool")
  Rel(invocation_client, crypto_trading_svc, "HTTPS + HMAC — private network")
  Rel(invocation_client, messaging_svc, "HTTPS + HMAC — private network")
  Rel(agent_runtime, core_tools, "Direct in-process dispatch")
  Rel(agent_runtime, general_tools, "Direct in-process dispatch")

  Rel(trading_tools, venues, "HTTP/WebSocket")
  Rel(trading_tools, postgres, "Trades, positions, bots")
  Rel(messaging_tools, email_providers, "SMTP/API")
  Rel(messaging_tools, chat_providers, "Bot API")
  Rel(agent_runtime, llm_providers, "LLM completions")
  Rel(agent_runtime, redis, "State, streams")
```

## Key Differences From Current State

1. **Agent Core is capability-agnostic.** It no longer imports trading or
   messaging implementation modules. It dispatches capability-owned tools
   through the invocation client over the private network.

2. **Capability services are independently deployable.** `crypto-trading` and
   `messaging` each have their own health endpoints, invocation stores, and
   provider connections. A venue outage degrades only the trading service.

3. **Visibility is a multi-factor predicate.** Tool visibility requires:
   known tool + requested by skill + exactly one owner + owner is
   core/general/capability-active + readiness satisfied + service healthy.

4. **The domain package is the shared contract authority.** Registry, ownership,
   and contract types live in `packages/domain/` — imported by Agent Core and
   both capability services. No implementation code crosses these boundaries.

5. **Activation is explicit and durable.** The `agent_capability_activations`
   table is the single source of truth. Skills request tools, activation
   enables the capability, both are required (two-key model).

6. **Routes are canonical.** Public API uses `/capabilities/crypto-trading`
   and `/capabilities/messaging`. Legacy `/capabilities/trading` remains as
   a declared deprecation alias only.
