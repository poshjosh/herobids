# Agent Permission Levels

Three permission levels control what an agent can do inside its container: **Restricted**, **Standard**, and **Full**. The user selects a level when creating or editing an agent. The platform translates the selection into tool visibility, sandbox configuration, and execution privileges.

All three levels run inside the same isolated Docker container. The container is the security boundary. Permission levels control agent behavior complexity, not host safety.

## Capability Matrix

| Capability | Restricted | Standard | Full |
|---|---|---|---|
| `execute_code` (JS/Python) | Yes | Yes | Yes |
| `execute_shell` | No | Yes | Yes |
| Network sandbox (`sandbox-exec.sh`) | Yes | Yes | Yes |
| Package install (npm/pip) | Via `execute_code` deps only | Yes (shell) | Yes (shell + system) |
| System packages (apk/apt) | No | No | Yes (root) |
| Root access | No | No | Yes (sudo) |
| Filesystem scope | Workspace + sandbox | Workspace + temp | Entire container |

## Level Details

### Restricted

- `execute_code` only (JS/Python via `sandbox-exec.sh`).
- No general shell access.
- Network restricted to public internet (RFC 1918 blocked, cloud metadata blocked).
- Cannot install system packages.
- Filesystem scoped to workspace + sandbox directory.

### Standard (default)

- Everything in Restricted, plus `execute_shell`.
- Shell commands run as the non-root `agent` user (via `sudo -u agent`).
- Same sandbox network restrictions as Restricted.
- Can install user-level packages (`npm install`, `pip install`).
- Can interact with git, run build tools, use standard dev tooling.
- Working directory validated to stay inside the workspace.

### Full

- Everything in Standard, plus root access via passwordless `sudo`.
- Shell commands run as root (the container's default user).
- Can install system packages (`apk add`, `apt install`).
- Can bind ports, run servers, modify container-level config.
- Filesystem: entire container filesystem — `execute_shell` allows absolute paths and paths outside workspace.
- Network: **same as Standard**. The sandbox wraps tool execution at all levels because agent containers have `DATABASE_URL` and `REDIS_URL` with full platform credentials. Unrestricted network is deferred until a follow-up removes direct DB/Redis credentials from agent containers.

## `execute_shell` Tool

`execute_shell` is a `direct`-tier tool registered in `TOOL_CATALOG` with category `execute-filesystem`. It runs arbitrary shell commands inside the agent container.

### Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `command` | string | Yes | Shell command to execute |
| `timeoutMs` | number | No | Execution timeout in ms (1000-600000) |
| `workingDir` | string | No | Working directory relative to workspace root |
| `description` | string | No | Brief description for audit logging |

### Execution Flow

1. **Capability policy check** — rate limit, concurrency, enable/disable via `capabilityEngine.checkAccess`.
2. **Permission gate** — `restricted` is rejected fail-closed (the tool should never be visible, but rejects if somehow called).
3. **Working directory resolution** — `standard` validates paths stay inside workspace via `resolveWorkspacePath`; `full` allows arbitrary absolute paths.
4. **Sandbox wrapping** — all commands are wrapped with `sandbox-exec.sh` when available.
5. **User privilege** — `standard` runs the inner command as `sudo -u agent sh -lc "<command>"`; `full` runs as `sh -lc "<command>"` (root).
6. **Execution** via `child_process.exec` with timeout and output limits from the capability grant or runtime policy.
7. **Audit** via `capabilityEngine.recordEnd()` with input summary, output summary, duration.

### Returns

```typescript
{ stdout: string; stderr: string; exitCode: number; durationMs: number }
```

### Capability Grant Defaults

```typescript
{
  capability: 'execute_shell',
  tier: 'direct',
  enabled: true,
  limits: { maxPerMinute: 10, maxConcurrent: 2, timeoutMs: 120_000, maxResponseBytes: 1_048_576 },
}
```

## Tool Visibility Gating

Tool visibility is controlled at agent startup via `permanentlyExcludedTools` in the `RuntimeToolVisibilityController`.

When the agent process starts (`apps/worker/src/agent.ts`):
1. Read `agentConfig.permissionLevel` (defaults to `'standard'` via `DEFAULT_PERMISSION_LEVEL`).
2. If `permissionLevel === 'restricted'`, add `'execute_shell'` to `permanentlyExcludedTools`.
3. The `RuntimeToolVisibilityController` applies permanent exclusions to every skill's `requiredTools` array, so `execute_shell` never appears in tool schemas sent to the LLM.

`execute_code` remains visible at all levels.

## Type and Schema

```typescript
// packages/domain/src/config/schema.ts
export const PermissionLevelSchema = z.enum(['restricted', 'standard', 'full']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

// packages/domain/src/enums.ts
export const DEFAULT_PERMISSION_LEVEL = 'standard' as const;
```

The `PermissionLevel` type is re-exported from `packages/domain/src/config/index.ts`.

## API

### Create Agent

`POST /agents` accepts an optional `permissionLevel` field:

```json
{ "permissionLevel": "standard" }
```

If omitted, the column default (`'standard'`) applies. Invalid values return 400.

### Update Agent

`PATCH /agents/:id` accepts `permissionLevel` in the update body.

### Read Agent

`GET /agents/:id` returns `permissionLevel` in the response.

### Chat-Assisted Flow

The Guided Setup chat does not surface the permission level choice. It silently uses `standard` (the column default).

## Frontend

The permission level selector lives in the create/edit agent form under **Advanced Settings > AI tab** (tab 0). It renders as three radio-style option cards:

- **Restricted** — "Code execution only..."
- **Standard** (default, visually indicated) — "Developer access..."
- **Full** — "Full environment control..."

Form state uses `AgentFormState.permissionLevel`. The field is mapped to `ADVANCED_FIELD_TAB` tab 0 for validation error navigation.

## DB Schema

```sql
ALTER TABLE agents ADD COLUMN permission_level VARCHAR(16) NOT NULL DEFAULT 'standard';
```

All existing agents were migrated to `standard`.
