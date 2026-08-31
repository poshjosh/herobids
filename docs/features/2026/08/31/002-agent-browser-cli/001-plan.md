# Install agent-browser CLI in Agent Containers

**Status:** Ready to implement
**Estimated effort:** ~2 days
**Dependencies:** [Agent Permission Levels](../001-agent-permission-levels/001-plan.md) (provides `execute_shell`)

## Summary

Install the [agent-browser](https://github.com/vercel-labs/agent-browser) Rust CLI
in the agent Docker image and configure it via environment variables to connect to
our existing Browserless pool. This enables agents to run `agent-browser` commands
via `execute_shell`, making external skills from the skills.sh ecosystem (which
use `Bash(agent-browser:*)`) work out of the box.

No Chrome in the agent container. The CLI (~30 MB Rust binary) acts as a thin
client that connects to Browserless over the Docker network.

```
Agent Container (<1 GB)                Browser Pool (existing)
+-----------------------+              +----------------------------+
| agent-browser CLI     |   HTTP/CDP   | Browserless (chromium)     |
|  (Rust, ~30 MB)       +------------->|  Chrome instance(s)        |
|                       |              |                            |
| No Chrome installed   |              | 2 GB, 2+ sessions          |
+-----------------------+              +----------------------------+
```

## Goals

- Agents with `standard` or `full` permission level can run `agent-browser`
  commands via `execute_shell`.
- External skills that reference `Bash(agent-browser:*)` work without
  translation layers.
- Agent containers stay under 1 GB memory (CLI only, no local Chrome).
- Browser sessions are served by the existing Browserless pool.
- Feature is gated behind `browserPool.enabled` — off by default.

## Non-Goals

- Running Chrome inside agent containers.
- Replacing or deprecating `browse_interactive` (it remains for platform-native
  skills; deprecation is a separate decision).
- Changing the Browserless pool configuration (it already works).
- Implementing `execute_shell` (that is the permission levels plan).

## Prerequisite: Sandbox Exemption for Browserless

`execute_shell` wraps all commands in `sandbox-exec.sh`, which blocks RFC 1918
addresses. Browserless runs on the Docker network at a private IP (e.g.
`172.x.x.x`). The `agent-browser` CLI configured with `-p browserless` connects
to Browserless via HTTP — this connection is blocked by the sandbox.

**Resolution:** The permission levels plan must add a targeted allowlist in
`sandbox-exec.sh` for the Browserless host. The sandbox already maintains
iptables rules per namespace; adding one `ACCEPT` rule before the `REJECT`
block for a specific operator-configured IP is a minimal, auditable change.

The allowlist is operator-controlled: the Browserless URL comes from
`config/default.yaml → browserPool.url`. At container startup, the worker
resolves this URL to an IP and passes it as an env var
(`SANDBOX_ALLOWED_HOSTS`). The sandbox script reads this var and inserts
`-A OUTPUT -d <ip> -j ACCEPT` rules before the RFC 1918 reject rules.

If `browserPool.enabled` is false, no allowlist is injected and the sandbox
is unchanged. This keeps the zero-config security posture intact.

**Alternative considered:** Skip the sandbox for `agent-browser` commands
entirely. Rejected — the agent container has `DATABASE_URL` and `REDIS_URL`
credentials. Skipping the sandbox would let the agent reach Postgres/Redis.
The targeted allowlist is the safer path.

---

## Detailed Plan

### 1. Dockerfile: Install agent-browser CLI

**File:** `docker/Dockerfile.agent`

Add `agent-browser` installation to the `runtime` stage after the existing
`apk add` line:

```dockerfile
# ── runtime image ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache iproute2 iptables ip6tables python3 py3-pip git

# Install agent-browser CLI (Rust binary, connects to remote Browserless —
# no local Chrome needed). Pinned to a specific version for reproducibility.
# The `install` step is deliberately NOT run — we do not want Chrome for
# Testing (~684 MB) in the agent container.
RUN npm install -g agent-browser@0.14.0

# ... rest of runtime stage unchanged
```

**Why `npm install -g`:** The `agent-browser` npm package ships pre-built
native Rust binaries for linux-x64 and linux-arm64. `npm install -g` places
the binary on `PATH` at `/usr/local/bin/agent-browser`. No Rust toolchain
needed at build time.

**Alpine compatibility:** The npm package includes a musl-compatible binary
for Alpine (`@aspect-build/agent-browser-linux-x64-musl` or similar). If the
pre-built binary does not run on Alpine, fall back to installing `gcompat`
(`apk add --no-cache gcompat`) for glibc shim support. This needs
verification during implementation (see Open Questions).

**Version pinning:** Pin to a specific version (`@0.14.0` or current latest)
per AGENTS.md dependency rules. Update via a deliberate Dockerfile change,
not a floating `latest` tag.

**Docker conventions compliance:** This follows the "Other images" pattern
from `docs/best-practices/docker.md` — the agent-browser binary is a
third-party tool installed in the agent image, not a build target from the
shared Dockerfile. No changes to the root `Dockerfile` or its multi-stage
pipeline.

### 2. Operator Config: Extend browserPool schema

**File:** `packages/domain/src/config/schema.ts`

Extend `BrowserPoolConfigSchema` with a field for the Browserless API token
(needed by `agent-browser -p browserless`):

```typescript
export const BrowserPoolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  apiKey: z.string().default(''),   // <-- new: Browserless API token
  maxSessionDurationMs: z.number().int().positive().default(60_000),
  defaultViewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
  }).default({}),
}).superRefine((data, ctx) => {
  if (data.enabled && !data.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'browserPool.url is required when browserPool.enabled is true',
    });
  }
}).default({});
```

**File:** `config/default.yaml`

```yaml
browserPool:
  enabled: false
  url: ""
  apiKey: ""                  # Browserless API token (optional for self-hosted)
  maxSessionDurationMs: 60000
  defaultViewport:
    width: 1280
    height: 720
```

The `apiKey` field defaults to empty string. Self-hosted Browserless
(our Docker Compose setup) does not require an API key. The field exists
for production deployments using Browserless Cloud or other hosted providers.

### 3. Env Var Forwarding: Pass Browserless config to agent containers

**File:** `apps/worker/src/agents/runtime-lifecycle.ts`

Add three new env vars to `buildAgentEnv()`, following the existing
`BROWSER_POOL_URL` pattern:

```typescript
// agent-browser CLI — Browserless provider configuration.
// These env vars are read directly by the agent-browser binary (not by our code).
if (config.browserPoolUrl) {
  envOut['AGENT_BROWSER_PROVIDER'] = 'browserless';
  envOut['BROWSERLESS_API_URL'] = config.browserPoolUrl;
}
if (config.browserPoolApiKey) {
  envOut['BROWSERLESS_API_KEY'] = config.browserPoolApiKey;
}
```

**File:** `apps/worker/src/agents/runtime-lifecycle.ts` (AgentEnvConfig interface)

```typescript
export interface AgentEnvConfig {
  // ... existing fields ...
  browserPoolUrl?: string;
  browserPoolApiKey?: string;   // <-- new
}
```

**File:** `apps/worker/src/index.ts` (where config is wired)

Wire `browserPoolApiKey` from `appConfig.browserPool.apiKey` into the
`AgentEnvConfig`, alongside the existing `browserPoolUrl` wiring.

**File:** `apps/worker/src/agents/docker-agent-manager.ts`

Add `browserPoolApiKey` to `DockerAgentManagerConfig` and forward it in
the legacy env builder (same pattern as `browserPoolUrl`).

**Env vars injected into agent containers when `browserPool.enabled`:**

| Env var | Value | Read by |
|---------|-------|---------|
| `BROWSER_POOL_URL` | `browserPool.url` | Our `browse_interactive` tool (existing) |
| `AGENT_BROWSER_PROVIDER` | `browserless` | `agent-browser` CLI |
| `BROWSERLESS_API_URL` | `browserPool.url` | `agent-browser` CLI |
| `BROWSERLESS_API_KEY` | `browserPool.apiKey` | `agent-browser` CLI |

The first two are already forwarded. The last two are new. Both sets
point at the same Browserless instance — one for our platform tool, one
for the CLI.

### 4. Sandbox: Allow Browserless host

**File:** `scripts/sandbox-exec.sh`

Add a targeted allowlist read from the `SANDBOX_ALLOWED_HOSTS` env var.
This var contains a comma-separated list of IP addresses or CIDR ranges
that the sandbox should allow before applying the RFC 1918 reject rules.

Insert the following block **before** the RFC 1918 reject rules:

```sh
# Allow operator-configured hosts (e.g. Browserless pool on Docker network).
# SANDBOX_ALLOWED_HOSTS is a comma-separated list of IPs or CIDRs.
if [ -n "${SANDBOX_ALLOWED_HOSTS:-}" ]; then
  IFS=',' read -r ALLOWED_HOST REST <<EOF
${SANDBOX_ALLOWED_HOSTS}
EOF
  while [ -n "$ALLOWED_HOST" ]; do
    ip netns exec "$NS" iptables -A OUTPUT -d "$ALLOWED_HOST" -j ACCEPT 2>/dev/null || true
    if [ -n "$REST" ]; then
      IFS=',' read -r ALLOWED_HOST REST <<EOF
${REST}
EOF
    else
      ALLOWED_HOST=""
    fi
  done
fi

# Block RFC 1918 and link-local within the namespace
ip netns exec "$NS" iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT 2>/dev/null || true
# ... existing rules ...
```

**File:** `apps/worker/src/agents/runtime-lifecycle.ts`

When `browserPool.enabled`, resolve the Browserless URL to an IP and
pass it as `SANDBOX_ALLOWED_HOSTS`:

```typescript
if (config.browserPoolUrl) {
  // Resolve Docker service name to IP for sandbox allowlist.
  // At container runtime, Docker DNS resolves service names.
  // Pass the hostname — sandbox-exec.sh will resolve it via the
  // container's DNS. If the URL is already an IP, pass it directly.
  const browserHost = new URL(config.browserPoolUrl).hostname;
  envOut['SANDBOX_ALLOWED_HOSTS'] = browserHost;
}
```

**Note:** `sandbox-exec.sh` uses public DNS (8.8.8.8) inside the
namespace, which cannot resolve Docker service names. The allowlist must
use IPs, not hostnames. The worker should resolve the hostname before
passing it. However, Docker service IPs can change across restarts.

**Simpler approach:** Instead of resolving IPs, use a Docker network
alias with a known IP, or — more practically — add the allowlist rule
in the **host** network namespace (before entering the sandbox namespace)
using the Docker DNS. The `SANDBOX_ALLOWED_HOSTS` env var would contain
the hostname, and the iptables rule would be inserted *before* namespace
creation while Docker DNS is still available. Implementation detail to
resolve during build.

**Simplest approach (recommended):** The Browserless container has a
predictable Docker Compose service name (`browser-pool`). At container
startup time (before sandbox creation), resolve this via a `getent hosts`
call and cache the IP. Pass the resolved IP in `SANDBOX_ALLOWED_HOSTS`.

### 5. Skill Update: Browser skill instructions

**File:** `packages/domain/src/skills.ts`

Update `BROWSER_SKILL.instructions` to document `agent-browser` CLI
availability:

```typescript
export const BROWSER_SKILL: SkillDefinition = {
  // ... id, slug, name, description unchanged ...
  instructions: `You have access to browser automation tools.

## Platform browser tool

- Use \`browse_interactive\` for structured browser automation via the platform.
  Actions: open, snapshot, click, fill, screenshot, get_text, close.

## agent-browser CLI

If you have the \`system/programming\` skill (which provides \`execute_shell\`),
you can also run \`agent-browser\` commands via \`execute_shell\`:

\`\`\`
execute_shell({ command: 'agent-browser open https://example.com' })
execute_shell({ command: 'agent-browser snapshot -i' })
execute_shell({ command: 'agent-browser click @e2' })
execute_shell({ command: 'agent-browser close' })
\`\`\`

The CLI connects to a shared browser pool — no local Chrome needed.
It supports sessions (\`--session <name>\`), accessibility snapshots,
element refs (@eN), screenshots, and all standard agent-browser commands.
Run \`agent-browser --help\` for the full command list.

When using external skills that reference \`agent-browser\`, use
\`execute_shell\` to run their commands.

Always close browser sessions when done to free resources.`,
  requiredTools: ['browse_interactive', 'send_message', 'publish_artifact'],
  // ... rest unchanged ...
};
```

**Note:** `execute_shell` is not added to `BROWSER_SKILL.requiredTools`
because it belongs to `PROGRAMMING_SKILL`. The agent needs both skills
to use the CLI path. The skill dependency system handles this — when the
agent adds `system/browser`, it can also add `system/programming` if it
needs shell access.

### 6. Docker Compose: Local dev

**File:** `docker-compose.dev.yaml`

No changes needed. The `browser-pool` service is already configured.
When `browserPool.enabled` is set to `true` in the operator config and
the URL points to `http://browser-pool:3000`, the env vars flow
automatically to agent containers.

For local dev testing, set in `.env` or `config/default.yaml`:

```yaml
browserPool:
  enabled: true
  url: "http://browser-pool:3000"
```

---

## Testing Strategy

| What | Type | Notes |
|---|---|---|
| `agent-browser` binary runs on Alpine | Build verification | Build the image, run `agent-browser --version` |
| `agent-browser -p browserless` connects to our Browserless pool | Integration test | Run inside agent container on Docker network |
| Sandbox allows Browserless host when `SANDBOX_ALLOWED_HOSTS` is set | Unit test (shell) | Run `sandbox-exec.sh` with env var, verify connectivity |
| Sandbox still blocks other RFC 1918 hosts | Unit test (shell) | Verify `curl http://172.17.0.1:5432` is rejected |
| `execute_shell` + `agent-browser` end-to-end | Integration test | Agent calls `execute_shell({ command: 'agent-browser open https://example.com && agent-browser snapshot -i' })` |
| Env vars forwarded correctly | Unit test | Verify `buildAgentEnv()` output includes `AGENT_BROWSER_PROVIDER`, `BROWSERLESS_API_URL` when `browserPool.enabled` |
| External skill (google-flights) works end-to-end | UAT | Agent installs skill, reads SKILL.md, runs `agent-browser` commands via `execute_shell` |

---

## Rollout

1. **Verify Alpine compatibility.** Build the image locally, run
   `agent-browser --version` and `agent-browser -p browserless open https://example.com`
   against the local Browserless pool. This is the first gate — if the binary
   doesn't run on Alpine, we need the `gcompat` shim.
2. **Verify Browserless API compatibility.** Confirm that `agent-browser -p browserless`
   works with `ghcr.io/browserless/chromium` (our image). The Browserless
   Sessions API may differ between v1 and v2.
3. **Deploy sandbox changes.** Update `sandbox-exec.sh` with the allowlist.
   Deploy new agent image.
4. **Deploy env var forwarding.** Update worker to forward the new env vars.
5. **Deploy skill instructions.** Update `BROWSER_SKILL` text.
6. **Test with a real agent.** Create an agent with the flight search goal,
   `standard` permission level, `system/browser` + `system/programming` skills.
   Verify it can install the google-flights skill and search flights.

---

## Risks

| Risk | Mitigation |
|---|---|
| `agent-browser` binary doesn't run on Alpine (musl) | Try `gcompat` shim; if that fails, use a Debian-based agent image variant |
| Browserless API incompatibility (v1 vs v2) | Test before deploying; if incompatible, use `--cdp` mode with direct CDP URL instead of `-p browserless` |
| Sandbox allowlist IP changes on Docker network restart | Resolve hostname to IP at container startup; if IP changes mid-session, the daemon reconnects |
| `agent-browser` daemon consumes too many PIDs | Default PID limit is 50; daemon + CLI should use ~5. Monitor and raise if needed |
| `agent-browser install` downloads Chrome inside the container | Do not expose `agent-browser install` — the CLI is configured for remote Browserless only. The agent would need `execute_shell` to run it, but it would fail due to disk space and the sandbox blocks the download |

---

## Open Questions

1. **Alpine/musl binary verification.** Does `npm install -g agent-browser`
   on `node:22-alpine` produce a working binary? Needs a local build test.

2. **Browserless Sessions API compatibility.** Does `agent-browser -p browserless`
   work with `ghcr.io/browserless/chromium:latest`? The CLI may expect
   Browserless Cloud's Sessions API which may differ from the self-hosted
   Chromium image. Fallback: use `--cdp ws://browser-pool:3000` directly.

3. **Sandbox hostname resolution.** The simplest approach is resolving the
   Docker hostname to an IP at agent startup and passing it via
   `SANDBOX_ALLOWED_HOSTS`. Needs implementation detail — where exactly
   does this resolution happen (worker before container launch, or inside
   the container at startup)?

4. **`agent-browser` daemon idle timeout.** The daemon defaults to 1 hour
   idle timeout. Agent containers may live longer. Should we configure a
   shorter idle timeout via `AGENT_BROWSER_IDLE_TIMEOUT_MS` to free
   resources sooner?

---

## Supersedes

This plan, combined with the [Agent Permission Levels](../001-agent-permission-levels/001-plan.md)
plan (which provides `execute_shell`), supersedes
[Phase 2: Script Execution](../../pending/001-agent-capability-surge/002-plan-script-execution.md).
`execute_shell` is a general-purpose shell tool that covers skill script
execution, `agent-browser` CLI usage, and any other shell-based workflow.
A dedicated `run_skill_script` tool is no longer needed.
