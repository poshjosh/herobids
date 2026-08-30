# Phase 1: Browser Pool + HTTP Client Tool

**Status:** Ready to implement
**Estimated effort:** ~1 week
**Dependencies:** None (builds on existing Nomad infrastructure and agent tool system)

## Summary

Add two capabilities that unlock the majority of external skills and API-based agent tasks:

1. **Browser pool service** — a shared, auto-scaling Browserless container on Nomad that agents connect to over the private network. Agents get interactive browser automation (open pages, click, fill forms, screenshot, read accessibility trees) without Chrome in their container.
2. **HTTP client tool** — a structured `http_request` tool for calling APIs with custom methods, headers, and bodies. Simpler and safer than routing through `execute_code` + `curl`.

## Goals

- Agents can execute external skills that reference `agent-browser` or browser automation.
- Agents can call structured APIs (REST, GraphQL) with authentication headers.
- Agent containers remain under 1GB memory.
- Browser session costs are metered per-agent.
- The browser pool scales with demand using existing Nomad auto-scaling.

## Non-Goals

- MCP client support (Phase 2).
- Running skill-bundled scripts from `scripts/` directories (Phase 2).
- Persistent browser sessions across ticks (Phase 2 — this phase uses stateless sessions with opt-in cookie save/restore).
- Anti-bot bypass / stealth mode (use Scrapfly or similar as a future `browse_url` backend upgrade, orthogonal to this plan).
- Replacing existing `search_web` / `browse_url` tools (those remain as lightweight HTTP-based tools; the new tools are additive).

---

## Architecture

### Browser Pool Service

```
Agent Container (<1GB)               Browser Pool (Nomad service job)
┌─────────────────────┐              ┌──────────────────────────────┐
│ Agent Runtime        │   CDP/HTTP   │ Browserless (GPL, unmodified)│
│  └─ browse_interactive ──────────→ │  ├─ Chrome instance 1        │
│     tool (port)      │  over private│  └─ Chrome instance 2        │
│                      │  network     │                              │
│ No Chrome installed  │              │ 2GB container, 2 sessions    │
└─────────────────────┘              └──────────────────────────────┘
```

The browser pool is a **Nomad service job** running the `ghcr.io/browserless/chromium` image. It:
- Accepts CDP WebSocket connections and HTTP API requests.
- Manages a configurable pool of concurrent Chrome sessions.
- Queues requests when all sessions are busy.
- Runs on the existing agent node pool (Nomad places it where there's capacity).
- Is discoverable by agents via Nomad service discovery or a static config URL.

**Facade pattern:** The agent tool code talks to an abstraction (`BrowserPoolPort`) that knows how to acquire a CDP endpoint, not to Browserless directly. Swapping to a custom image or a cloud provider (Browserbase, etc.) later means changing only the adapter behind the port.

### HTTP Client Tool

A new `http_request` tool in the agent tool registry. No external service needed — it runs in-process in the agent container using Node's built-in `fetch`.

---

## Detailed Plan

### 1. Browser Pool — Nomad Job Definition [DONE]

**File:** `infra/nomad/browser-pool.nomad.hcl` (new)

A Nomad service job:
```hcl
job "browser-pool" {
  type = "service"

  group "browser" {
    count = 1  # Start with 1, scale via config

    network {
      port "http" { to = 3000 }
    }

    task "browserless" {
      driver = "docker"

      config {
        image = "ghcr.io/browserless/chromium:latest"
        ports = ["http"]
      }

      env {
        MAX_CONCURRENT_SESSIONS = "2"
        TIMEOUT                 = "60000"
        QUEUE_LENGTH            = "10"
        DEFAULT_LAUNCH_ARGS     = "[\"--no-sandbox\",\"--disable-dev-shm-usage\"]"
      }

      resources {
        memory = 2048  # 2GB — fits 2 concurrent sessions
        cpu    = 500
      }
    }

    service {
      name = "browser-pool"
      port = "http"

      check {
        type     = "http"
        path     = "/json/version"
        interval = "10s"
        timeout  = "3s"
      }
    }
  }
}
```

**Scaling path:** Change `count` and `MAX_CONCURRENT_SESSIONS` via Nomad job variables. Increase `resources.memory` to 4096/8192 for more sessions per container.

**Operator config** (`config/default.yaml`):
```yaml
browserPool:
  enabled: true
  url: "http://browser-pool.service.consul:3000"  # or Nomad service discovery
  maxSessionDurationMs: 60000
  defaultViewport:
    width: 1280
    height: 720
```

### 2. Domain — Browser Pool Port [DONE]

**File:** `packages/domain/src/ports/browser-pool.ts` (new)

```typescript
export interface BrowserSession {
  cdpEndpoint: string;
  sessionId: string;
}

export interface BrowserPoolPort {
  acquireSession(): Promise<Result<BrowserSession, BrowserPoolError>>;
  releaseSession(sessionId: string): Promise<void>;
}
```

This is the abstraction the agent tool talks to. The initial adapter calls Browserless's HTTP API to get a CDP endpoint.

### 3. Infrastructure Adapter — Browserless Adapter [DONE]

**File:** `packages/venues/src/browser-pool/browserless-adapter.ts` (new, or a new package)

Implements `BrowserPoolPort`:
- `acquireSession()`: `GET <browserlessUrl>/json/new` → returns CDP WebSocket URL.
- `releaseSession()`: closes the CDP connection (Browserless auto-cleans).
- Handles connection errors, timeouts, queue-full responses.

### 4. Agent Tool — `browse_interactive` [DONE]

**File:** `apps/worker/src/tools/browser.ts` (new)

A new agent tool that provides structured browser automation:

```typescript
const BrowseInteractiveParamsSchema = z.object({
  action: z.enum(['open', 'snapshot', 'click', 'fill', 'screenshot', 'get_text', 'close']),
  url: z.string().url().optional(),         // for 'open'
  selector: z.string().optional(),           // for 'click', 'fill', 'get_text'
  value: z.string().optional(),              // for 'fill'
  waitFor: z.string().optional(),            // CSS selector or 'networkidle'
});
```

The tool:
1. Acquires a CDP endpoint from the `BrowserPoolPort`.
2. Connects via a lightweight CDP client (e.g., `chrome-remote-interface` or raw WebSocket — no Playwright needed in the agent container).
3. Executes the requested action.
4. Returns structured results (accessibility snapshot, text content, screenshot base64, etc.).
5. Releases the session on `close` or on tool error.

**Session lifecycle within a tick:** The tool maintains a session for the duration of the judge loop (multiple tool calls in one tick). When the tick ends, any open session is released. This gives the agent a natural workflow: `open` → `snapshot` → `click` → `snapshot` → `close`.

**Skill gating:** The tool is gated behind `system/web-access` (extend the existing skill) or a new `system/browser` skill. The agent must add the skill before the tool becomes available.

### 5. Agent Tool — `http_request` [DONE]

**File:** `apps/worker/src/tools/http-client.ts` (new)

```typescript
const HttpRequestParamsSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional().default(15000),
});
```

The tool:
1. Validates the URL against a denylist (no internal network, no `file://`, no localhost unless operator-configured).
2. Executes the request using Node's built-in `fetch`.
3. Returns `{ status, headers, body }` with body truncated to a configurable max (e.g., 50KB).
4. Follows redirects (up to 5).
5. Strips sensitive response headers.

**Skill gating:** Gated behind a new `system/http` skill or added to `system/web-access`.

### 6. Domain — Skill Definitions [DONE]

**File:** `packages/domain/src/skills.ts` (modify)

Option A — extend `WEB_ACCESS_SKILL`:
- Add `browse_interactive` and `http_request` to `requiredTools`.
- Update instructions to document the new tools.

Option B — new skills:
- `BROWSER_SKILL`: `browse_interactive`, `send_message`, `publish_artifact`.
- `HTTP_SKILL`: `http_request`, `send_message`.

**Recommendation:** Option A for `http_request` (it's a natural extension of web access). New `system/browser` skill for `browse_interactive` (it has different resource requirements and the agent should explicitly opt in to browser sessions which cost money).

### 7. Tool Registration and Catalog [DONE]

**Files:**
- `packages/domain/src/tools.ts` — add `browse_interactive` and `http_request` to `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`.
- `apps/worker/src/agent.ts` — register the new tools in the tool registry, wire `BrowserPoolPort` into the tool context.

### 8. Cost Metering [DONE]

**File:** `apps/worker/src/agent.ts` (modify, in the tool execution path)

After `browse_interactive` completes:
- Record session duration via `usageBillingService.recordBrowserSession({ agentId, durationMs })`.
- The billing service already supports extensible event types — add a `browser_session` event type.

After `http_request` completes:
- Record as a lightweight event (URL, status, response size). Low cost — primarily for observability, not billing.

### 9. Operator Config Validation [DONE]

**File:** `config/default.yaml` + config schema in `packages/domain/`

```yaml
browserPool:
  enabled: false                    # Feature flag — off by default
  url: ""                           # Required when enabled
  maxSessionDurationMs: 60000       # Per-session hard limit
  defaultViewport:
    width: 1280
    height: 720

httpClient:
  enabled: true                     # On by default — low risk
  maxResponseBytes: 51200           # 50KB response body cap
  denyList:                         # Blocked URL patterns
    - "10.*"
    - "172.16.*"
    - "192.168.*"
    - "169.254.*"
    - "localhost"
    - "127.0.0.1"
```

### 10. Docker Compose (Local Dev) [DONE]

**File:** `docker-compose.dev.yaml` (modify)

Add a `browser-pool` service for local development:
```yaml
browser-pool:
  image: ghcr.io/browserless/chromium:latest
  environment:
    MAX_CONCURRENT_SESSIONS: "2"
    TIMEOUT: "60000"
  ports:
    - "3001:3000"
  deploy:
    resources:
      limits:
        memory: 2G
```

---

## Testing Strategy

| What | Type | Notes |
|---|---|---|
| `browse_interactive` tool — param validation, error paths | Unit test | Mock `BrowserPoolPort`, test action dispatch, error formatting |
| `http_request` tool — param validation, URL denylist, response truncation | Unit test | Mock `fetch`, test all HTTP methods, headers, body handling |
| `BrowserPoolPort` adapter — connection lifecycle | Unit test | Mock HTTP responses from Browserless |
| Browser pool Nomad job — health check, session limits | Integration test | Requires running Browserless container |
| End-to-end: agent adds `system/browser` skill, uses `browse_interactive` to navigate a page | Integration test | Requires full stack + browser pool |
| `http_request` against real endpoints | Integration test | Test against httpbin.org or similar |

---

## Rollout

1. **Feature-flagged:** `browserPool.enabled = false` by default. Enable per-environment.
2. **Local dev first:** Browser pool in `docker-compose.dev.yaml`. Test with real agents.
3. **Staging:** Deploy Nomad job to staging cluster. Run flight-search agent end-to-end.
4. **Production:** Enable after staging validation. Start with `count = 1`, `MAX_CONCURRENT_SESSIONS = 2`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Browser pool becomes a bottleneck under load | Nomad auto-scaling + queue. Monitor queue depth as a scaling signal. |
| Chrome crashes / memory leaks in long sessions | `maxSessionDurationMs` hard limit. Browserless auto-restarts Chrome on crash. |
| Agents abuse browser sessions (infinite loops) | Per-agent session duration budget in cost profile. Tool enforces hard timeout. |
| Browserless GPL concern | Running unmodified as a standalone service — no distribution, no copyleft trigger. Facade pattern allows swap to custom image later. |
| `http_request` used to probe internal network | URL denylist blocks RFC 1918, link-local, localhost. Operator can extend. |

---

## Acceptance Criteria

- [ ] Agent can call `browse_interactive` with actions: open, snapshot, click, fill, screenshot, get_text, close.
- [ ] Agent can call `http_request` with GET/POST/PUT/PATCH/DELETE and receive structured response.
- [ ] Browser pool runs as a Nomad service job, discoverable by agents.
- [ ] Browser sessions are metered per-agent.
- [ ] `browse_interactive` is gated behind a skill (agent must add it first).
- [ ] `http_request` blocks requests to internal network addresses.
- [ ] Local dev stack includes browser pool in docker-compose.
- [ ] Feature is off by default, enabled via operator config.
- [ ] `pnpm lint` and `pnpm test` pass.
