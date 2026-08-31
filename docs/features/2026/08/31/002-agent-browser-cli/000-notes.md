# agent-borwser cli

## How agent-browser works

**It's a native Rust CLI binary** ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)) that uses a client-daemon architecture:

1. **CLI (Rust)** — parses commands, sends them to the daemon via IPC
2. **Daemon (Rust)** — manages Chrome via CDP (Chrome DevTools Protocol). No Node.js required for the daemon. It starts automatically on first command and persists between commands.

### Chrome / Chromium

- `agent-browser install` downloads Chrome from **Chrome for Testing** (Google's official automation channel) — ~684MB
- It also auto-detects existing Chrome, Brave, Playwright, and Puppeteer installations
- You can point it to a custom executable with `--executable-path` or `AGENT_BROWSER_EXECUTABLE_PATH`
- Critically, it supports **remote browser providers** via `-p <provider>`:
  - `--cdp <port|url>` — connect to any browser exposing a CDP endpoint
  - `-p browserless` — connects to a Browserless cloud/self-hosted instance
  - `-p browserbase`, `-p browseruse`, `-p kernel`, `-p agentcore` — other cloud providers

### Memory

- The CLI binary itself is lightweight Rust — negligible memory
- The real memory cost is Chrome. But here's the key: **agent-browser doesn't need to run Chrome locally**. With `-p browserless` or `--cdp`, it connects to a remote Chrome instance over CDP

### Sessions

- `--session <name>` gives isolated browser instances with their own cookies, storage, and history
- Sessions persist via the daemon — the skill uses `--session flights`, `--session econ`, `--session biz`

## What this means for us

We already have the Browserless container running. agent-browser can connect to it via `-p browserless` or `--cdp`. The architecture would be:

```
Agent Container (~1GB)                Browser Pool (existing)
┌──────────────────────┐              ┌──────────────────────────┐
│ agent-browser CLI     │   CDP/HTTP   │ Browserless (chromium)   │
│  (Rust, ~30MB)        ├─────────────→│  Chrome instance(s)      │
│                       │              │                          │
│ No Chrome installed   │              │ 2GB, 2 sessions          │
└──────────────────────┘              └──────────────────────────┘
```

The agent-browser CLI in the agent container would be configured (via env vars) to use our existing browser pool as its Browserless provider. It would add minimal memory to the agent container — it's just the Rust binary. Chrome lives in the browser pool, exactly as we designed.

The external skills from skills.sh would then just work — their `Bash(agent-browser:*)` commands execute directly. No translation layer needed.

## The Problem

We want agents to run `agent-browser` CLI commands on the commandline so external skills from skills.sh work out of the box. The CLI is a lightweight Rust binary (~30MB) that talks to Chrome via CDP. We already have Chrome running in our Browserless pool. We need to put the CLI in agent containers and point it at our pool.

There are three constraints to solve:

### Constraint 1: `execute_code` only speaks JavaScript and Python

The `execute_code` tool has a hardcoded language enum: `z.enum(['javascript', 'python'])`. There is no `bash` or `shell` option. An agent that reads a skill telling it to run `agent-browser open ...` would need to wrap it in a `child_process.exec()` call inside JavaScript — clunky, and the LLM would need to figure that out from the skill instructions which say `Bash(...)`.

### Constraint 2: The sandbox blocks internal network access

`sandbox-exec.sh` blocks all RFC 1918 addresses. Our Browserless pool runs on the Docker network at a private IP (e.g., `browser-pool:3000` → `172.x.x.x`). Code executed through `execute_code` runs inside the sandbox and can't reach it. The `agent-browser` CLI would connect to Browserless over the Docker network, which is blocked.

### Constraint 3: `agent-browser` needs a daemon

`agent-browser` uses a client-daemon architecture. The first command starts a background daemon process that holds the Chrome CDP connection. Subsequent commands are fast because they talk to the running daemon. This is critical for the `--session` workflow used by skills. The daemon needs to survive across multiple `execute_code` calls within a tick.

## Assumptions

- We control the agent Docker image and can add binaries to it.
- The Browserless pool is accessible on the Docker network.
- The current 50-PID default limit is sufficient (agent-browser daemon + CLI invocations).
- We're OK with `agent-browser` connecting to Browserless directly (not through the sandbox's network namespace).

## Solutions

### Option A: Add `bash` language to `execute_code` + sandbox exemption for Browserless

Extend `execute_code` to accept `language: 'bash'`, skip the sandbox for bash executions (or whitelist the Browserless host IP in the sandbox iptables), install `agent-browser` in the Docker image.

**Pros:** Minimal new code — extends existing tool. Skills that say `Bash(agent-browser:*)` map naturally.

**Cons:** 
- Mixing sandbox exemptions is fragile — punching holes in the network sandbox for one service opens a precedent.
- Bash mode would need its own security considerations (the current sandbox was designed for JS/Python).
- The daemon lifecycle is awkward inside `execute_code` — each invocation is an isolated `exec()` call. The daemon would start on the first call and persist as an orphan process. Not terrible (it's inside a container), but not clean.
- Doesn't solve the fundamental issue of skill compatibility cleanly — the LLM still needs to understand that `Bash(agent-browser:*)` means "use `execute_code` with language bash."

### Option B: New `run_browser_command` tool (dedicated, no sandbox)

Create a new platform tool specifically for `agent-browser` commands. It runs `agent-browser` directly (no sandbox) so it can reach the Docker network. It uses the same capability policy and metering as `browse_interactive`.

**Pros:** 
- Clean separation — browser commands have their own tool with proper descriptions, parameters, and capability gating.
- No sandbox — the tool runs `agent-browser` as a direct subprocess, so it can reach Browserless on the Docker network.
- The LLM sees a tool it can map to the skill instructions.
- Daemon lifecycle is manageable — the tool can start the daemon on first call and clean up on session teardown (same pattern as `cleanupBrowserSessions`).

**Cons:**
- Yet another tool — adds to the tool catalog.
- The LLM still needs to translate `Bash(agent-browser:*)` from skill instructions into `run_browser_command(...)` calls. The skill says "run this shell command" but the agent calls a structured tool.
- Duplicates some of what `browse_interactive` already does — two browser tools.

### Option C: Add `bash` language to `execute_code` + run `agent-browser` outside the sandbox

The simplest path: extend `execute_code` to support `language: 'bash'`, and configure `agent-browser` via env vars to connect to Browserless (using `-p browserless` provider mode). The key insight: **`agent-browser -p browserless` connects to Browserless over HTTP, not CDP on the Docker network**. If we expose Browserless on a non-RFC1918 address, or use `-p browserless` with a routable URL, the sandbox doesn't matter.

But wait — Browserless in our Docker compose is on the private network. We'd need to expose it on a routable address, which undermines the network isolation purpose.

**Rejected for the same sandbox reasons as Option A.**

### Option D: Add `bash` language to `execute_code`, run `agent-browser` **outside** the sandbox (selectively)

Extend `execute_code` to support `language: 'bash'`. For bash executions, **don't use the sandbox** — run directly. The rationale: `agent-browser` itself has domain allowlists (`--allowed-domains`) and its own security model. The sandbox's RFC 1918 blocking is counterproductive here — we *want* the CLI to reach internal services.

**Pros:**
- Minimal new code — one language enum addition + conditional sandbox bypass.
- External skills just work — `Bash(agent-browser:*)` maps directly to `execute_code({ language: 'bash', code: 'agent-browser open ...' })`.
- The daemon lifecycle works naturally — the daemon starts on first bash execution and persists in the container for subsequent calls.
- No new tool needed.
- The LLM already knows how to use `execute_code`.

**Cons:**
- Bash mode without the sandbox means agents can hit internal services. This is a security consideration.
- However: the agent container is already on the Docker network and has `CAP_NET_ADMIN`. The sandbox only applies to `execute_code` — all other tools (web search, HTTP client, etc.) already access internal services directly. The sandbox is defense-in-depth for code execution, not the primary security boundary.
- We could mitigate by only allowing bash when the browser skill is active, or by restricting which commands are allowed.

### Option E (Recommended): Add `bash` language to `execute_code` with a restricted command allowlist

Extend `execute_code` to accept `language: 'bash'`. Bash mode runs **without the network sandbox** but with a **command allowlist** — only pre-approved binaries can be executed. Initially, the allowlist is just `agent-browser`.

The `system/browser` skill's `requiredTools` already includes `execute_code` via its dependency on `system/programming`. When the agent has both skills, it can run bash with `agent-browser` commands.

**Implementation:**

1. **Dockerfile.agent**: Add `agent-browser` binary to the image. Use `agent-browser install` to download Chrome for Testing — **no, wait**. We don't want Chrome in the agent container. Instead, configure `agent-browser` via env vars to use our Browserless pool as its browser provider.

   ```dockerfile
   # Install agent-browser CLI (Rust binary, ~30MB, no Chrome needed)
   RUN npm install -g agent-browser
   ```

   With env vars set in the container:
   ```
   AGENT_BROWSER_PROVIDER=browserless
   BROWSERLESS_API_URL=http://browser-pool:3000
   ```

   This way `agent-browser` connects to our existing Browserless pool. No Chrome in the agent container. Memory stays under 1GB.

2. **execute_code**: Add `'bash'` to the language enum. When `language === 'bash'`, validate the code against an allowlist of permitted commands. Write the code to a `.sh` file. Run it **without** `sandbox-exec.sh` but with a timeout.

3. **Env var forwarding**: Forward `AGENT_BROWSER_PROVIDER` and `BROWSERLESS_API_URL` (computed from `browserPool.url`) to agent containers. Follow the existing `BROWSER_POOL_URL` pattern.

4. **Skill update**: Update `BROWSER_SKILL` instructions to mention that agents can run `agent-browser` commands via `execute_code({ language: 'bash', code: 'agent-browser ...' })`. Add `execute_code` to `BROWSER_SKILL.requiredTools` or make `system/programming` a dependency.

5. **PID limit**: The 50-PID default accommodates the daemon + CLI calls. No change needed.

**Pros:**
- External skills just work — `Bash(agent-browser:*)` maps directly.
- No Chrome in agent containers — just the CLI binary, connected to our pool.
- Reuses existing infrastructure (Browserless pool, execute_code tool, capability policy).
- The command allowlist prevents arbitrary internal network access from bash mode.
- Clean upgrade path — we can add more allowed commands later (e.g., `curl`, `git`) as needs arise.

**Cons:**
- The allowlist adds a maintenance surface. But it's small and explicit.
- Bash mode without the full sandbox is a deliberate security tradeoff. Acceptable because: the allowed commands are curated, the container is already capability-constrained, and the alternative (no bash at all) makes the entire skills.sh ecosystem unusable.

## Open Questions

1. **`agent-browser` binary size on Alpine**: The npm package ships a pre-built Rust binary. Need to verify it runs on Alpine (musl libc) or if we need the `gcompat` package.

2. **Browserless compatibility**: `agent-browser -p browserless` expects the Browserless Sessions API. Our pool runs `ghcr.io/browserless/chromium`. Need to verify the API compatibility — Browserless v2 vs v1.

3. **Daemon cleanup**: The `agent-browser` daemon starts on first command and idles. When the agent container stops, it dies naturally. But within a tick, should we explicitly clean up? The existing `cleanupBrowserSessions` pattern could extend to killing the daemon.

4. **Should `browse_interactive` be deprecated or kept alongside?** Two browser tools is confusing. But `browse_interactive` works for agents with platform-native skills. Could keep both during transition.

5. **Command allowlist scope**: Start with just `agent-browser`. Should we also allow `agent-browser install` (for Chrome for Testing download)? No — we don't want Chrome in the container. The allowlist should block `agent-browser install`.

## Caveats

- **Browserless API compatibility** is the biggest risk. If `agent-browser -p browserless` expects an API endpoint our Browserless image doesn't expose, the whole approach fails. This needs to be verified before implementation.
- **Alpine/musl compatibility** for the Rust binary needs verification.
- **The sandbox bypass for bash** is a conscious security decision that should be documented and reviewed.