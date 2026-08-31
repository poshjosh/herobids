# Agent Permission Levels

**Status:** In Progress

## Summary

Introduce three user-facing permission levels that control what an agent can do inside its container: **Restricted**, **Standard**, and **Full**. The user selects a level when creating or editing an agent. The platform translates the selection into concrete tool visibility, sandbox configuration, and container-level policy.

All three levels run inside the same isolated Docker container. The container is the security boundary. Permission levels control agent behavior complexity, not host safety.

**Platform safety invariant:** Agent containers currently have direct `DATABASE_URL` and `REDIS_URL` credentials. All permission levels — including Full — use `sandbox-exec.sh` for tool execution to block RFC 1918 (internal network) access. This prevents agents from reaching Postgres, Redis, or other platform services via shell or code execution. Full mode differs from Standard in root access, system packages, and filesystem scope — not network freedom. Unrestricted network for Full is deferred until a follow-up workstream removes direct DB/Redis credentials from the agent container (see Future Work).

## Permission Levels

| Level | Label | User intent | Default |
|-------|-------|-------------|---------|
| `restricted` | Restricted | "I want the agent to think and write code, but not touch anything" | No |
| `standard` | Standard | "I want the agent to work like a developer on my project" | **Yes** |
| `full` | Full | "I want the agent to own this environment completely" | No |

### Restricted (current behavior)

- `execute_code` only (JS/Python via `sandbox-exec.sh`).
- No general shell access.
- Network restricted to public internet (RFC 1918 blocked, cloud metadata blocked).
- Cannot install system packages.
- Filesystem scoped to workspace + sandbox directory.

### Standard (new default)

- Everything in Restricted, plus:
- New `execute_shell` tool: run arbitrary shell commands as the container's non-root user.
- Network: same sandbox restrictions as Restricted (`sandbox-exec.sh` wraps commands). Public internet allowed; internal Docker network and cloud metadata blocked.
- Can install user-level packages (`npm install`, `pip install`).
- Can interact with git, run build tools, use standard dev tooling.
- Filesystem: workspace + temp directories.

### Full

- Everything in Standard, plus:
- Root access via `sudo` (passwordless, configured in Dockerfile).
- Can install system packages (`apk add`, `apt install`).
- Can bind ports, run servers, modify container-level config.
- Filesystem: entire container filesystem.
- Network: **same as Standard** (`sandbox-exec.sh` wraps tool execution). Public internet only; internal Docker network blocked. This is intentional — the agent container has `DATABASE_URL` and `REDIS_URL` with full platform credentials. Unrestricted network would let the agent reach Postgres/Redis directly, risking data corruption or deletion across the entire platform. Unrestricted network is deferred to a follow-up that removes direct DB credentials from the container (see Future Work).

### Capability matrix

| Capability | Restricted | Standard | Full |
|---|---|---|---|
| `execute_code` (JS/Python) | Yes | Yes | Yes |
| `execute_shell` | No | Yes | Yes |
| Network sandbox (`sandbox-exec.sh`) | Yes | Yes | Yes (same as Standard) |
| Package install (npm/pip) | Via `execute_code` deps only | Yes (shell) | Yes (shell + system) |
| System packages (apk/apt) | No | No | Yes (root) |
| Root access | No | No | Yes (sudo) |
| Filesystem scope | Workspace + sandbox | Workspace + temp | Entire container |
| Audit logging | Yes | Yes | Yes |

## Decisions (from discussion)

1. **Default is `standard`.** All new agents (form, chat-assisted, API) default to `standard` unless explicitly overridden. Existing agents migrated to `standard` (not `restricted`) to expand capability without breaking existing workflows.
2. **New `execute_shell` tool**, not an extension of `execute_code`. Clean separation: `execute_code` is for structured JS/Python execution with dependency management; `execute_shell` is for arbitrary shell commands. Different capability boundaries, easier to gate by permission level.
3. **Chat-assisted flow silently uses `standard`.** The Guided Setup chat does not surface the permission level choice. It passes `standard` by default.
4. **Frontend placement:** Permission level selector in the create/edit agent form Advanced Settings, AI/Agent tab (tab 0).
5. **Container is the security boundary.** No capability-based permission system inside the container. No declarative dependency manifest. Just: give the agent a shell, log everything.
6. **All levels use `sandbox-exec.sh` for network isolation.** Agent containers share the Docker network with Postgres, Redis, docker-proxy, and other agent containers. The `sandbox-exec.sh` network namespace blocks RFC 1918 access for tool execution at all permission levels, preventing agents from reaching platform infrastructure. Full mode gains root + system packages + full filesystem, not unrestricted network. Unrestricted network for Full is a future enhancement gated on removing direct DB/Redis credentials from agent containers.

## Non-Goals

- Changing the container isolation model (Docker remains the boundary).
- Adding a permission system inside the container (capabilities, seccomp profiles).
- Surfacing permission level in the Guided Setup chat flow (silently defaults to `standard`).
- Per-command audit UI (audit logging is infrastructure; no user-facing audit viewer in this feature).

---

## Detailed Plan

### Phase 1: Domain and Schema (no runtime changes yet)

#### 1.1 Domain: define `PermissionLevel` type

**Files:**
- `packages/domain/src/types.ts` (or new `packages/domain/src/permission-level.ts`)

**Changes:**
- Define `PermissionLevel = 'restricted' | 'standard' | 'full'` branded type.
- Export `DEFAULT_PERMISSION_LEVEL = 'standard'` constant.
- Add Zod schema: `PermissionLevelSchema = z.enum(['restricted', 'standard', 'full'])`.

#### 1.2 Domain: register `execute_shell` in tool catalog

**Files:**
- `packages/domain/src/tools.ts`
- `packages/domain/src/skills.ts`

**Changes:**
- Add `'execute_shell'` to `KNOWN_AGENT_TOOL_NAMES`.
- Add `execute_shell` entry to `TOOL_CATALOG` with category `'execute-filesystem'`.
- Update `PROGRAMMING_SKILL.requiredTools` to include `'execute_shell'` alongside `'execute_code'`. The skill declares both; visibility is gated by permission level at runtime (step 3.2).
- Alternatively, create a dedicated `SHELL_ACCESS_SKILL` if cleaner separation is preferred. Recommendation: keep it in `PROGRAMMING_SKILL` since both are "code execution" tools and the permission level handles gating.

#### 1.3 DB: add `permission_level` column

**Files:**
- `packages/db/src/schema/agents.ts`
- New migration file via `drizzle-kit generate`

**Changes:**
- Add column: `permissionLevel: varchar('permission_level', { length: 16 }).notNull().default('standard')`.
- Migration sets default `'standard'` for all existing agents. No data backfill needed beyond the column default.
- Position the column near `style` and `runtimePolicyOverrides` (agent-level config cluster).

#### 1.4 API: accept `permissionLevel` on create and update

**Files:**
- `apps/api/src/routes/agents.ts` (CreateAgentSchema, UpdateAgentSchema, POST handler, PATCH handler)
- `apps/api/src/agents/agent-create-normalization.ts` (PrepareAgentCreateFieldsParams, prepareAgentCreateFields)

**Changes:**

In `CreateAgentSchema`:
```typescript
permissionLevel: PermissionLevelSchema.default('standard').optional(),
```

In `UpdateAgentSchema`:
```typescript
permissionLevel: PermissionLevelSchema.nullable().optional(),
```

In `POST /agents` handler:
- Pass `permissionLevel` through to the `agents.insert()` call. Default resolution: if omitted, column default (`'standard'`) applies.

In `PATCH /agents/:id` handler:
- Include `permissionLevel` in the update fields when provided.

In `prepareAgentCreateFields`:
- Add `permissionLevel` to `PrepareAgentCreateFieldsParams`. No special normalization needed — it's a simple pass-through.

In `enrichAgentResponse`:
- Include `permissionLevel` in the agent GET response so the frontend can read it.

#### 1.5 API: chat-assisted flow defaults to `standard`

**Files:**
- `apps/api/src/routes/chat.ts` (`GuidedSetupCreateAgentInput`, `executeChatAction` `create_agent` case)

**Changes:**
- Do NOT add `permissionLevel` to `GuidedSetupCreateAgentInput` or the LLM tool schema. The chat flow does not expose this choice.
- In the `create_agent` case of `executeChatAction`, the `agents.insert()` call relies on the column default (`'standard'`). No code change needed if the column default is correct. If explicit is preferred, pass `permissionLevel: 'standard'` in the insert.

---

### Phase 2: New `execute_shell` tool

#### 2.1 Worker: implement `execute_shell` tool

**Files:**
- New file: `apps/worker/src/tools/shell.ts`
- `apps/worker/src/tools/index.ts`

**Changes:**

Create `execute_shell` tool following the same patterns as `execute_code` in `code.ts`:

```typescript
const ShellExecuteParamsSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  timeoutMs: z.coerce.number().int().min(1_000).max(600_000).optional()
    .describe('Execution timeout in milliseconds (1000-600000)'),
  workingDir: z.string().optional()
    .describe('Working directory relative to workspace root'),
  description: z.string().optional()
    .describe('Brief description of what this command does. For audit/logging.'),
});
```

Execution flow:
1. Capability policy check via `ctx.capabilityEngine.checkAccess('execute_shell', ...)`.
2. Resolve working directory (default: workspace root, validate no path traversal outside workspace for `restricted`/`standard`).
3. Wrap command with `sandbox-exec.sh` for network isolation (all permission levels). The sandbox blocks RFC 1918/cloud metadata, allowing only public internet — this protects platform services (Postgres, Redis, docker-proxy) that share the Docker network.
4. Determine execution user from `ctx.permissionLevel`:
   - `standard`: run as non-root container user.
   - `full`: prefix command with `sudo -n` for root access.
   - `restricted`: tool should never be visible (gated at tool visibility layer), but fail-closed if somehow called.
5. Execute via `child_process.exec` with timeout and output limits (reuse `getRuntimePolicy()` pattern from `code.ts`).
6. Return `{ stdout, stderr, exitCode, durationMs }`.
7. Audit log via `capabilityEngine.recordEnd()`.

For `full` mode root access: the execution flow (step 4 above) prefixes commands with `sudo -n` when `permissionLevel === 'full'`. The Dockerfile must configure passwordless sudo for the agent user (step 2.3).

#### 2.2 Worker: add `execute_shell` capability grant

**Files:**
- `apps/worker/src/agents/capability-policy.ts`

**Changes:**
- Add `execute_shell` to `DEFAULT_CAPABILITY_GRANTS`:
```typescript
{
  capability: 'execute_shell',
  tier: 'direct',
  enabled: true,  // visibility controlled by permission level, not by default enable/disable
  limits: { maxPerMinute: 10, maxConcurrent: 2, timeoutMs: 120_000, maxResponseBytes: 1024 * 1024 },
},
```
- The grant is always present in DEFAULT_CAPABILITY_GRANTS. Tool visibility (step 3.2) handles whether the agent sees it based on permission level.

#### 2.3 Docker: configure sudo for `full` mode

**Files:**
- `docker/Dockerfile.agent`

**Changes:**
- Install `sudo` in the agent image: `apk add --no-cache sudo`.
- Create a non-root agent user (if not already present) and add passwordless sudo:
  ```dockerfile
  RUN adduser -D -h /workspace agent && \
      echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent
  USER agent
  ```
- The Dockerfile change is always applied. Whether sudo is actually used depends on the agent's permission level at runtime. A `standard` agent has sudo installed but never invokes it (tool doesn't prefix `sudo`). A `restricted` agent never sees `execute_shell` at all.

---

### Phase 3: Runtime wiring

#### 3.1 Worker: pass `permissionLevel` to the agent container

**Files:**
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agents/docker-agent-manager.ts` (DockerContainerSpec)

**Changes:**

In `agent-session-manager.ts` (`reconcileStartingSessions`):
- Read `agent.permissionLevel` from the DB record.
- Include it in the `agentConfig` object:
  ```typescript
  permissionLevel: agent.permissionLevel ?? 'standard',
  ```
- It flows to the container via the `AGENT_CONFIG` env var (already serialized as JSON).

In `DockerContainerSpec`:
- Add optional `permissionLevel?: string` field for documentation clarity (the value is already inside `agentConfig`, but making it explicit in the spec interface is good practice).

#### 3.2 Worker: gate `execute_shell` visibility by permission level

**Files:**
- `apps/worker/src/runtime-tool-visibility.ts` (RuntimeToolVisibilityController)
- `apps/worker/src/runtime-composition.ts` (or wherever the descriptor is built)

**Changes:**

The `RuntimeToolVisibilityController` already has a permanent exclusion mechanism. Extend it:

- When building the visibility controller at agent startup, read `permissionLevel` from `agentConfig`.
- If `permissionLevel === 'restricted'`: add `'execute_shell'` to permanent exclusions.
- If `permissionLevel === 'standard'` or `'full'`: `execute_shell` is visible (no exclusion).
- `execute_code` remains visible at all levels.

This is the simplest approach: the skill declares both tools, and the visibility controller subtracts based on permission level.

#### 3.3 Worker: pass permission level to tool context

**Files:**
- `apps/worker/src/agent.ts` (or wherever `ToolContext` is constructed)
- `packages/domain/src/tools.ts` (ToolContext interface)

**Changes:**
- Add `permissionLevel: PermissionLevel` to the `ToolContext` interface.
- When constructing the tool context for each invocation, read `permissionLevel` from `agentConfig` and include it.
- `execute_shell` reads `ctx.permissionLevel` to decide whether to prefix commands with `sudo -n` (full) or run as non-root (standard). Both levels use `sandbox-exec.sh` for network isolation.
- `execute_code` behavior is unchanged (always uses `sandbox-exec.sh` when available, regardless of permission level).

---

### Phase 4: Frontend

#### 4.1 Frontend: add `permissionLevel` to form state

**Files:**
- `apps/web/src/features/agents/agent-form-state.ts`

**Changes:**
- Add to `AgentFormState`:
  ```typescript
  permissionLevel: 'restricted' | 'standard' | 'full';
  ```
- In `agentToFormState()`: read `agent.permissionLevel`, default to `'standard'` if absent.
- In `intentToFormState()`: pass through `permissionLevel` from intent, default to `'standard'`.

#### 4.2 Frontend: add `permissionLevel` to payloads

**Files:**
- `apps/web/src/features/agents/agent-payloads.ts`

**Changes:**
- Add `permissionLevel` to `CreateAgentIntentPayloadInput` and `UpdateAgentPayloadInput` interfaces.
- In `buildCreateAgentPayload()`: include `permissionLevel` in the returned object. Default: `'standard'`.
- In `buildUpdateAgentPayload()`: include `permissionLevel` in the returned object.

#### 4.3 Frontend: permission level selector in Advanced Settings AI tab

**Files:**
- `apps/web/src/features/agents/AgentFormBody.tsx`
- New file: `apps/web/src/features/agents/PermissionLevelSelector.tsx` (optional — could be inline)
- i18n locale files

**Changes:**

Create a `PermissionLevelSelector` component (or inline in AgentFormBody). Design: three radio-style option cards, similar to the existing Filter Trades selector pattern in the Strategy tab.

Each card shows:
- **Restricted** — "Code execution only. The agent can run JavaScript and Python but cannot use shell commands or install packages."
- **Standard** (default, visually indicated) — "Developer access. The agent can run shell commands, install packages, use git, and run build tools."
- **Full** — "Full environment control. The agent has root access, can install system packages, and manage the entire container filesystem."

Place it in the AI config tab (tab 0) of AdvancedSettingsSection, after the model slot and before the AgentControlsSection:

```tsx
// Inside AgentFormBody, in the aiConfig slot of AdvancedSettingsSection:
<div style={{ display: 'flex', flexDirection: 'column', gap: '48px' }}>
  {props.modelSlot}
  <PermissionLevelSelector
    value={props.value.permissionLevel}
    onChange={(level) => props.onChange({ permissionLevel: level })}
  />
  <AgentControlsSection ... />
  {props.computeBudgetSlot}
  {/* email delivery */}
</div>
```

#### 4.4 Frontend: form validation

**Files:**
- `apps/web/src/features/agents/form-validation.ts`

**Changes:**
- No special validation needed — all three values are valid. The selector guarantees a valid selection.
- Add `permissionLevel` to `ADVANCED_FIELD_TAB` mapping (tab 0, AI).

#### 4.5 Frontend: i18n

**Files:**
- i18n locale files (`en.ts`, `ar.ts`, `hi.ts`)

**Changes:**
- Add keys:
  - `agents.permissionLevel.label` — "Agent Permissions"
  - `agents.permissionLevel.restricted.label` — "Restricted"
  - `agents.permissionLevel.restricted.description` — "Code execution only. The agent can run JavaScript and Python but cannot use shell commands or install packages."
  - `agents.permissionLevel.standard.label` — "Standard"
  - `agents.permissionLevel.standard.description` — "Developer access. The agent can run shell commands, install packages, use git, and run build tools."
  - `agents.permissionLevel.full.label` — "Full"
  - `agents.permissionLevel.full.description` — "Full environment control. The agent has root access, can install system packages, and manage the entire container filesystem."
  - `agents.permissionLevel.default` — "(default)"

#### 4.6 Frontend: CreateAgentPage and EditAgentModal

**Files:**
- `apps/web/src/features/agents/CreateAgentPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/create-agent-models.ts`

**Changes:**
- Default `permissionLevel: 'standard'` in the initial form state for create flow.
- Populate `permissionLevel` from the agent record in the edit flow (via `agentToFormState`).
- Include `permissionLevel` in the payload builders (already handled by step 4.2).

---

### Phase 5: Skill instructions update

#### 5.1 Update `PROGRAMMING_SKILL` instructions

**Files:**
- `packages/domain/src/skills.ts`

**Changes:**
- Update `PROGRAMMING_SKILL.instructions` to mention `execute_shell`:
  ```
  - Use `execute_code` to run JavaScript or Python for custom automation, external API calls, analysis, data processing etc.
  - Use `execute_shell` to run shell commands for git operations, build tools, package management, and system tasks.
  - The tools available to you depend on your permission level. If `execute_shell` is not available, use `execute_code` instead.
  ```

---

## Testing Plan

### Domain
- `PermissionLevelSchema` accepts `'restricted'`, `'standard'`, `'full'` and rejects other values.
- `TOOL_CATALOG` includes `execute_shell`; `assertToolCatalogMatchesRegistry` passes.
- `PROGRAMMING_SKILL.requiredTools` includes both `execute_code` and `execute_shell`.

### DB
- Migration adds `permission_level` column with default `'standard'`.
- Existing agents get `'standard'` after migration.

### API
- `POST /agents` without `permissionLevel` creates agent with `'standard'`.
- `POST /agents` with `permissionLevel: 'restricted'` persists correctly.
- `POST /agents` with `permissionLevel: 'full'` persists correctly.
- `POST /agents` with `permissionLevel: 'invalid'` returns 400.
- `PATCH /agents/:id` can update `permissionLevel`.
- `GET /agents/:id` returns `permissionLevel` in response.
- Chat-assisted `create_agent` creates agents with `'standard'` (column default).

### Worker: `execute_shell` tool
- `execute_shell` with `permissionLevel: 'standard'` wraps command in `sandbox-exec.sh`, runs as non-root.
- `execute_shell` with `permissionLevel: 'full'` wraps command in `sandbox-exec.sh`, runs with `sudo -n` (root).
- `execute_shell` returns stdout, stderr, exitCode, durationMs.
- `execute_shell` respects timeout and output limits.
- `execute_shell` rejects path traversal outside workspace (standard mode).
- Capability policy rate limits and concurrency are enforced.
- Both `standard` and `full` shell execution cannot reach RFC 1918 addresses (Postgres, Redis, docker-proxy).

### Worker: tool visibility
- Agent with `permissionLevel: 'restricted'` does NOT see `execute_shell` in tool list.
- Agent with `permissionLevel: 'standard'` sees both `execute_code` and `execute_shell`.
- Agent with `permissionLevel: 'full'` sees both `execute_code` and `execute_shell`.
- Agent with `permissionLevel: 'restricted'` still sees `execute_code`.

### Frontend
- Permission level selector renders in Advanced Settings > AI tab.
- Default selection is `'standard'` on create.
- Edit form populates from agent record.
- Changing permission level updates form state and payload.
- Selector is accessible (keyboard navigation, screen reader labels).

### Integration / UAT
- Create agent with `standard` → start → agent can use `execute_shell` to run `ls`, `git status`, `npm --version`.
- Create agent with `restricted` → start → agent cannot see or call `execute_shell`.
- Create agent with `full` → start → agent can use `execute_shell` to run `apk add curl`, `sudo whoami`.
- Edit running agent's permission level → requires stop first (existing 409 guard).

---

## Rollout

1. **DB migration** — adds `permission_level` column, default `'standard'`. All existing agents become `standard`. Non-breaking.
2. **Backend API** — accepts new field, backward compatible (omission uses default). Deploy alongside migration.
3. **Worker + Docker** — new tool, updated Dockerfile, visibility gating. Deploy new agent image.
4. **Frontend** — selector in form. Deploy after backend is live.

### Rollback plan

- If issues arise, remove `execute_shell` from `PROGRAMMING_SKILL.requiredTools` (or add it to permanent exclusions in the visibility controller). All agents fall back to `execute_code` only. The `permission_level` column and API field are inert without the tool.
- No data migration needed for rollback.

## Effort Estimate

| Phase | Scope | Estimate |
|-------|-------|----------|
| Phase 1: Domain + Schema + API | Type, catalog, migration, API schema | ~1 day |
| Phase 2: `execute_shell` tool + Docker | New tool, capability grant, Dockerfile | ~1 day |
| Phase 3: Runtime wiring | Session manager, visibility, tool context | ~0.5 day |
| Phase 4: Frontend | Form state, payloads, selector component, i18n | ~1 day |
| Phase 5: Skill instructions | Skill text update | ~0.5 hour |
| Testing | Unit + integration + UAT | ~1 day |
| **Total** | | **~4.5 days** |

## Resolved Questions

1. **`execute_shell` in `PROGRAMMING_SKILL` vs new skill.** Decision: keep in `PROGRAMMING_SKILL`. They're both code execution tools and the visibility controller handles gating by permission level. A separate skill adds no value.
2. **Audit log storage.** Decision: use existing `CapabilityPolicyEngine.recordEnd()` audit trail. No new storage for v1. A dedicated audit viewer can be added later.
3. **Network policy for `full` mode.** Decision: `full` uses the same `sandbox-exec.sh` network isolation as `standard`. Agent containers share the Docker network (`herobids_default`) with Postgres (full credentials), Redis (no auth), docker-proxy, and other agent containers. Skipping the sandbox would let a `full` agent run `psql $DATABASE_URL -c "DROP DATABASE herobids"` — a platform-level catastrophe. Unrestricted network is deferred to a follow-up that removes direct DB/Redis credentials from agent containers (see Future Work).
4. **`execute_code` behavior at `full` level.** Decision: `execute_code` always uses the sandbox at all levels. The user has `execute_shell` for broader access. Keeps behavior predictable.

## Future Work: Unrestricted Network for Full Mode

**Problem:** The agent container receives `DATABASE_URL` (Postgres, full credentials) and `REDIS_URL` (no auth) as environment variables. The agent process needs these for its own runtime (Redis broker protocol, DB queries for tools). But their presence means any unrestricted shell execution could reach and destructively modify platform infrastructure.

**Target architecture:**
1. **Remove `DATABASE_URL` from agent containers.** Move all agent DB queries (`list_bots`, `get_bot_status`, `list_positions`, instrument lookups, etc.) behind brokered messages. The agent sends a request to the worker via Redis; the worker executes the query and returns results. This follows the existing pattern used by `submit_decision` and `manage_bot`.
2. **Scope Redis access.** Use Redis ACLs to restrict the agent's Redis user to only its own stream keys (`agent:{agentId}:*`), or route through a thin proxy in the worker.
3. **Once credentials are removed**, `full` mode can skip `sandbox-exec.sh` safely — there are no credentials to exploit and no platform services to reach (or reaching them is harmless without credentials).

**Scope:** This is a significant refactor (~8 repositories with direct DB queries need to become brokered). It should be tracked as a separate feature/workstream, not blocked on by this plan.
