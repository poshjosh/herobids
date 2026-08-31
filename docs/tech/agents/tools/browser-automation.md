# Browser Automation

Agents have two browser automation paths: the platform `browse_interactive` tool and the `agent-browser` CLI. Both connect to a shared Browserless pool over CDP — no Chrome runs inside agent containers.

## Architecture

```
Agent Container (<1 GB)                Browser Pool (Browserless)
+-----------------------+              +----------------------------+
| browse_interactive    |   CDP/WS     | ghcr.io/browserless/       |
|  (platform tool)      +------------->|   chromium                 |
|                       |              |  Chrome instance(s)        |
| agent-browser CLI     |   CDP/WS     |                            |
|  (via execute_shell)  +------------->| 2 GB, 2+ concurrent        |
|                       |              |   sessions                 |
| No Chrome installed   |              |                            |
+-----------------------+              +----------------------------+
```

The browser pool runs as a Nomad service job (production) or a Docker Compose service (local dev) using the `ghcr.io/browserless/chromium` image. Agents discover it via the `browserPool.url` operator config.

## `browse_interactive` Tool

A platform-native tool that provides structured browser automation via CDP. Gated behind the `system/browser` skill.

### Actions

| Action | Required params | Returns |
|---|---|---|
| `open` | `url` | Navigates to URL, acquires CDP session |
| `snapshot` | — | Accessibility tree (AX nodes) or fallback body text |
| `click` | `selector` | Clicks element by CSS selector |
| `fill` | `selector`, `value` | Fills form field by CSS selector |
| `screenshot` | — | Page screenshot as base64 PNG |
| `get_text` | `selector` | Element text content (truncated to 50 KB) |
| `close` | — | Releases browser session, records billing |

### Parameters

```typescript
{
  action: 'open' | 'snapshot' | 'click' | 'fill' | 'screenshot' | 'get_text' | 'close';
  url?: string;       // required for 'open'
  selector?: string;  // CSS selector for 'click', 'fill', 'get_text'
  value?: string;     // required for 'fill'
  waitFor?: string;   // optional CSS selector to wait for after navigation/click
}
```

### Session Lifecycle

- `open` acquires a CDP endpoint from the `BrowserPoolPort` and creates a WebSocket connection.
- Subsequent actions reuse the same CDP session within a tick (multiple tool calls).
- `close` releases the session and records billing.
- On agent session teardown, `cleanupBrowserSessions()` releases any leaked sessions and records billing for each.

### SSRF Protection

`open` validates URLs before navigation:
- Only `http:` and `https:` protocols allowed.
- Hostnames that resolve to private or reserved IPs are blocked via `isHostPrivate()`.

### Capability Grant

```typescript
{
  capability: 'browse_interactive',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 30, maxConcurrent: 1, timeoutMs: 60_000, maxResponseBytes: 1_048_576 },
}
```

## `agent-browser` CLI

The [agent-browser](https://github.com/vercel-labs/agent-browser) Rust CLI is installed globally in agent containers (`npm install -g agent-browser@0.14.0`). Agents use it via `execute_shell` for compatibility with external skills from the skills.sh ecosystem (which reference `Bash(agent-browser:*)`).

### Installation

The CLI is installed in `docker/Dockerfile.agent`:

```dockerfile
RUN apk add --no-cache gcompat && npm install -g agent-browser@0.14.0
```

`gcompat` provides glibc shim support — the pre-built Rust binary links against glibc but the base image is Alpine (musl).

### Connection

The CLI connects to Browserless via CDP, configured through a config file written by `agent-entrypoint.sh`:

```sh
# agent-entrypoint.sh
if [ -n "${AGENT_BROWSER_CDP_URL:-}" ]; then
  mkdir -p /home/agent/.agent-browser
  printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /home/agent/.agent-browser/config.json
  export AGENT_BROWSER_CONFIG="/home/agent/.agent-browser/config.json"
fi
```

The worker sets `AGENT_BROWSER_CDP_URL=ws://<browserless-host>:3000` when `browserPool.enabled` is true.

**Note:** The CLI does **not** use the `-p browserless` provider flag — that feature is not available in v0.14.0. It connects directly via CDP WebSocket using the `--cdp` flag or the config file.

### Usage via `execute_shell`

Agents with `standard` or `full` permission level (which grants `execute_shell`) can run:

```
execute_shell({ command: 'agent-browser open https://example.com' })
execute_shell({ command: 'agent-browser snapshot -i' })
execute_shell({ command: 'agent-browser click @e2' })
execute_shell({ command: 'agent-browser close' })
```

The CLI supports sessions (`--session <name>`), accessibility snapshots, element refs (`@eN`), screenshots, and all standard agent-browser commands. Run `agent-browser --help` for the full command list.

### Sandbox Interaction

`execute_shell` wraps all commands in `sandbox-exec.sh`, which blocks RFC 1918 addresses. Browserless runs on the Docker network at a private IP. The `SANDBOX_ALLOWED_HOSTS` mechanism (see [Tool Access and Sandboxing](../tool-access-and-sandboxing.md#sandbox_allowed_hosts)) inserts a targeted iptables ACCEPT rule for the Browserless host before the RFC 1918 reject rules.

If `browserPool.enabled` is false, `SANDBOX_ALLOWED_HOSTS` is not set and the sandbox blocks all internal addresses — `agent-browser` cannot reach Browserless.

## `make_http_request` Tool

A structured HTTP client for calling external APIs. Gated behind the `system/web-access` skill.

### Parameters

```typescript
{
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;                  // must be http: or https:
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;           // 1000-30000, default 15000
}
```

### Returns

```typescript
{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}
```

### Security

- **URL denylist**: operator-configurable patterns (`httpClient.denyList`) block matching hostnames. Defaults block RFC 1918 ranges, link-local, and localhost.
- **SSRF protection**: DNS resolution check via `isHostPrivate()` blocks hostnames that resolve to private or reserved IPs.
- **Redirect re-validation**: each redirect hop re-validates the target against the denylist and SSRF check.
- **Response truncation**: body is truncated to `httpClient.maxResponseBytes` (default 50 KB from config, overridable via capability grant).

### Capability Grant

```typescript
{
  capability: 'make_http_request',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 30, maxConcurrent: 3, timeoutMs: 15_000, maxResponseBytes: 262_144 },
}
```

## Browser Session Cost Metering

Browser sessions are metered per-agent via the `UsageBillingService`. When a session is closed (either by the agent calling `close` or by the platform during cleanup), `recordBrowserSession({ durationMs, browserSessionId })` is called.

The billing event is fire-and-forget — it does not block the tool response. The rate card entry is `browser.session_ms` in `config/default.yaml`.

`make_http_request` is not separately metered — the per-call cost is negligible. It is tracked via capability engine `recordStart`/`recordEnd` for observability.

## Operator Config

### `browserPool`

```yaml
browserPool:
  enabled: true                       # feature flag — off by default
  url: "http://browser-pool:3000"     # Browserless URL (required when enabled)
  apiKey: ""                          # Browserless API token (optional for self-hosted)
  maxSessionDurationMs: 60000         # per-session hard limit
  defaultViewport:
    width: 1280
    height: 720
```

When `browserPool.enabled` is true, the worker:
1. Wires `BrowserPoolPort` into the `browse_interactive` tool context.
2. Sets `BROWSER_POOL_URL`, `AGENT_BROWSER_CDP_URL`, and `SANDBOX_ALLOWED_HOSTS` in agent container env.

### `httpClient`

```yaml
httpClient:
  enabled: true                       # on by default
  maxResponseBytes: 51200             # 50 KB response body cap
  denyList:                           # blocked URL patterns
    - "10.*"
    - "172.16.*"
    - "192.168.*"
    - "169.254.*"
    - "localhost"
    - "127.0.0.1"
```

Both configs are validated at startup via Zod schemas. Missing required fields when enabled cause a fail-fast startup error.
