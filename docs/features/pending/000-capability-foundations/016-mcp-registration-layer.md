# MCP Registration And Transport Layer

**Status:** draft
**Created:** 2026-08-31
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)
**Prerequisite:** [First Repo-Local External Trading Backend](./005-trading-capability-extraction.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [ADR 008](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)

## Purpose

Add the Model Context Protocol (MCP) as the third registration and transport
mechanism for reaching external backends and third-party tool servers, after
direct API and skills. MCP is not a capability or a backend — it is a
packaging and transport layer that surfaces tools into the existing capability
model.

## Context

[013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
established that registration mechanism is separate from domain category. A
domain may be reached by direct API first, later wrapped by skills, and later
wrapped by MCP, without changing the underlying boundary.

The MCP ecosystem has converged as a standard for tool-server integration
across agent platforms (10,000+ tool servers, 97M+ monthly SDK downloads as of
mid-2026). Adding MCP client support allows agents to connect to external tool
servers without requiring the platform to build bespoke integrations for each
service.

MCP cuts across capabilities. An MCP server may provide:

- automation tools (a browser-use MCP server)
- trading tools (an exchange MCP server)
- messaging tools (a Slack or Gmail MCP server)
- general tools (a GitHub, Notion, or calendar MCP server)

The MCP client does not own the domain semantics of the tools it surfaces. It
is transport, discovery, and lifecycle management for external tool servers.

## Scope

This phase includes:

1. a platform MCP client that agents can use to connect to MCP servers
2. MCP server lifecycle management (connect, discover tools, call tools,
   disconnect)
3. tool namespace management to prevent conflicts with platform tools
4. operator-configured MCP server allowlists
5. MCP credential management (OAuth 2.1, API keys) for server authentication
6. per-agent metering of MCP tool calls
7. integration with the existing tool visibility and skill gating model

This phase does not include:

1. building custom MCP servers (this phase adds the client; servers are
   external)
2. changes to the external-backend boundary contract (MCP is a registration
   layer over the same contract, or a parallel path for third-party servers
   that are not platform-managed backends)
3. full shell access or unrestricted script execution
4. changes to native capability activation or the `agent_capability_activations`
   table

## Non-Goals

1. Do not model MCP as a native capability or an external backend. It is a
   registration and transport mechanism.
2. Do not let MCP bypass the existing tool visibility model. MCP-surfaced
   tools must still pass through skill gating and visibility composition.
3. Do not allow agents to connect to arbitrary MCP servers without operator
   authorization.
4. Do not let MCP tool names collide with platform tool names without explicit
   namespace resolution.
5. Do not require MCP as a prerequisite for external backend integration.
   Direct API remains the first mechanism.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   the external-backend boundary is proven with at least one backend.
2. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   establishes that registration mechanism is separate from domain category.
3. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   defines the boundary contract that MCP may wrap for platform-managed
   backends.
4. [ADR 008](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
   establishes that skills and MCP may later become registration and packaging
   layers over the same external-backend boundary.

## Fixed Decisions

1. MCP is a registration and transport mechanism, not a capability or backend.
   It does not get a `NativeCapabilityId` or `ExternalBackendId`.
2. MCP-surfaced tools are subject to the same visibility, skill gating, and
   capability engine rules as platform tools.
3. MCP server connections require operator authorization via an allowlist.
   Agents cannot connect to arbitrary endpoints.
4. MCP tool names are namespaced to prevent collisions with platform tools.
   Platform tools always take precedence in name resolution.
5. MCP credential storage reuses existing platform infrastructure (the
   `connections` table or an extension of it) rather than introducing a
   parallel credential system.
6. MCP server processes are not hosted inside agent containers. The platform
   manages MCP server connections through one of:
   - remote HTTP transport (Streamable HTTP) for cloud-hosted MCP servers
   - shared platform-managed MCP server instances for self-hosted servers
   - a combination based on operator configuration

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact MCP transport used (stdio subprocess managed by the platform vs
   Streamable HTTP to remote servers vs a combination)
2. whether MCP tools appear as dynamic tool registrations or are mediated
   through meta-tools (`connect_mcp`, `list_mcp_tools`, `call_mcp_tool`)
3. the exact namespace format for MCP-surfaced tools (e.g.,
   `mcp.github.create_issue` or `mcp:github:create_issue`)
4. whether MCP server connections are per-agent, per-tenant, or shared across
   agents based on operator config
5. whether a skill can declare MCP server dependencies that auto-connect on
   skill activation
6. the exact credential storage model (new table vs extension of `connections`)
7. test placement across domain, worker, API, and integration suites

## Open Questions

The following must be resolved before implementation begins. They are carried
forward from the original Phase 2 plan with additional context from the
capability-foundations model.

### MCP Server Lifecycle

1. **Who manages the MCP server process?**
   - Option A: Agent container runs MCP servers as child processes. Higher
     memory per container. Conflicts with the <1GB container constraint.
   - Option B: MCP servers run as shared platform services (like the browser
     pool). Lower per-agent cost, adds routing complexity.
   - Option C: Agents connect to remote MCP servers over Streamable HTTP. No
     local process, requires externally hosted servers.
   - **Direction:** Option C for cloud-hosted servers (GitHub, Slack, etc.),
     Option B for self-hosted servers that multiple agents share. Option A only
     if the server is lightweight and agent-specific. The platform manages the
     connection, not the server process inside the agent container.

### Authentication

2. **How do agents authenticate to MCP servers?**
   - MCP spec supports OAuth 2.1 + PKCE. The OAuth flow should be
     user-initiated (the user connects their GitHub/Slack account), not
     agent-initiated.
   - Credentials should be stored per-user or per-tenant, not per-agent,
     since multiple agents may share access to the same MCP server.
   - The `connections` table is the existing mechanism for user-authorized
     external service credentials. MCP credentials should integrate with or
     extend this model.

### Tool Namespace

3. **How are MCP tool name conflicts resolved?**
   - Platform tools always take precedence. If an MCP server exposes a tool
     with the same name as a platform tool, the MCP tool is either namespaced
     or hidden.
   - Namespace format needs to be LLM-friendly (models need to be able to
     call the tools by name without confusion).

### Cost Model

4. **How are MCP tool calls billed?**
   - Per-call metering through the capability engine, same as other tools.
   - Some MCP servers have their own billing (e.g., a paid API behind the
     MCP server). The platform meters its own costs (connection time, call
     count) separately from upstream server costs.

### Interaction with External Backends

5. **Can an MCP server wrap a platform-managed external backend?**
   - Example: an MCP server that exposes trading tools, where the underlying
     execution goes through `externals/trading/`.
   - If yes, the MCP layer is purely a packaging/discovery mechanism over the
     existing boundary contract. The platform dispatches through the boundary
     contract regardless of whether the call originated from a direct tool
     invocation or an MCP-mediated call.
   - If no, MCP servers and platform-managed backends are parallel paths.
   - **Direction:** Yes, MCP can wrap a platform-managed backend. This keeps
     registration mechanism orthogonal to execution backend, consistent with
     013's model.

## Acceptance Criteria

This phase is complete only when:

1. agents can connect to at least one MCP server and call its tools through
   the platform
2. MCP-surfaced tools appear in the agent's tool set with proper namespacing
3. MCP tool calls are subject to skill gating and visibility composition
4. MCP server connections respect an operator-configured allowlist
5. MCP tool calls are metered per-agent through the capability engine
6. MCP credentials are stored using existing platform credential infrastructure
   (or a justified extension)
7. MCP tool names do not collide with platform tool names
8. the platform does not host MCP server processes inside agent containers
   (except for explicitly allowed lightweight servers)
9. MCP server disconnection or failure does not crash the agent session —
   tools become unavailable gracefully
10. `pnpm lint` and `pnpm test` pass

## Validation

1. add integration tests for MCP server connection, tool discovery, and tool
   invocation through the platform
2. add namespace collision tests: platform tool takes precedence when an MCP
   server exposes a conflicting name
3. add allowlist enforcement tests: connection to a non-allowlisted server is
   rejected
4. add credential lifecycle tests: user authorizes, agent uses, credentials
   expire or are revoked, agent receives clear error
5. add graceful degradation tests: MCP server disconnects mid-session, affected
   tools become unavailable, agent session continues
6. add metering tests: MCP tool calls are recorded in the capability engine
7. run targeted domain, API, worker, and integration tests
8. run `pnpm lint`

## Deliverables

1. MCP client library or adapter in the platform (location TBD based on open
   latitude)
2. MCP server connection lifecycle management (connect, discover, call,
   disconnect)
3. tool namespace resolution and registration in the agent tool set
4. operator allowlist configuration and enforcement
5. credential storage integration (connections table or extension)
6. per-agent metering for MCP tool calls
7. agent-facing tools or meta-tools for MCP interaction (approach TBD per open
   latitude)
8. documentation for operators on configuring MCP server access

## Implementation Notes

### Relationship to the external-backend boundary

MCP and the external-backend boundary contract are complementary, not
competing:

```
Registration mechanisms          Execution backends
─────────────────────           ──────────────────
Direct API (current)  ────────→ externals/trading/
Skills (future)       ────────→ externals/automation/
MCP (this phase)      ────────→ third-party MCP servers
                                (or wrapping a platform backend)
```

For platform-managed backends (`trading`, `automation`), MCP is an optional
packaging layer. The underlying execution still crosses the boundary contract.

For third-party MCP servers (GitHub, Slack, Notion), MCP is the primary
transport. These servers are not platform-managed backends — they are external
services the agent connects to directly via the MCP protocol.

### Skill integration

Two possible models for how MCP tools interact with skills:

1. **Meta-tool model:** A `system/mcp` skill provides `connect_mcp`,
   `list_mcp_tools`, `call_mcp_tool`, `disconnect_mcp`. The agent explicitly
   manages MCP connections.
2. **Dynamic registration model:** Skills declare MCP server dependencies.
   When a skill is activated, the platform auto-connects to the declared MCP
   servers and registers their tools in the agent's tool set.

Model 1 is simpler and gives agents explicit control. Model 2 is more
seamless but adds complexity to skill activation. The choice is within open
latitude.

### Platform-core placement

The MCP client is platform-core infrastructure, not an external backend.
It lives in the platform codebase (likely `apps/worker/src/mcp/` or a shared
package) because it is a transport mechanism the platform provides to agents,
not a domain service with its own business semantics.
