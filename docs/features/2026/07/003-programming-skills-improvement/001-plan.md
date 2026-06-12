# Programming And File Management Skill Parity Plan

## Status

`todo`

## Goal

Bring Herobids agent programming capability to feature parity with aitradingbot.

Parity means:

1. Herobids exposes the same effective capability surface as aitradingbot for code execution plus workspace file management.
2. The `programming` skill stays narrowly scoped to code execution expertise.
3. A separate `file-management` skill owns workspace file manipulation.
4. `execute_code` supports both JavaScript and Python.
5. Code execution supports dependency installation with `npm` and `pip`.
6. Agents can persist files across ticks within the same runtime via workspace tools.
7. Code can use the public internet, while runtime filtering continues to block internal and private network access when the sandbox is available.

Backward compatibility is not a goal for this slice. The existing Herobids programming contract can be replaced directly.

## Product Decision

Feature parity with aitradingbot takes priority over security hardening when they conflict.

Where hardening can be kept without reducing parity, keep it. Examples:

- path validation inside the workspace root
- output truncation
- timeout caps
- dependency-name validation
- reserved execution directories

Where hardening would remove parity, parity wins. Examples:

- do not keep the runtime JavaScript-only for simplicity
- do not remove package installation to reduce supply-chain risk

## Current Baseline

### Herobids today

- `packages/domain/src/skills.ts` defines `programming` as a JavaScript-only skill with `requiredTools = ['execute_code', 'send_message', 'publish_artifact']`
- there is no built-in file-management skill for workspace access
- `apps/worker/src/tools/code.ts` accepts only `code` and optional `description`
- `apps/worker/src/tools/code.ts` writes to `/tmp/agent-sandbox/script.js` and runs `node`
- `packages/domain/src/tools.ts` has no filesystem tool names and no filesystem read or write categories

### aitradingbot target behavior to mirror

- aitradingbot exposes one programming skill that combines:
  - `execute_code`
  - `write_file`
  - `read_file`
  - `list_files`
  - `delete_file`
- `execute_code` supports:
  - `language: 'javascript' | 'python'`
  - `dependencies: string[]`
  - `timeoutMs`
  - structured execution results
- workspace behavior:
  - files under `/workspace/` persist across ticks
  - files do not survive runtime or container restart
  - `/workspace/sandbox` is reserved for code execution
- public internet access is allowed from executed code
- internal or private network access should remain filtered when sandboxing is active

### Herobids parity shape

Herobids should preserve the same effective capabilities while following the skill authoring rule that skills stay narrow in scope.

That means parity is delivered as a skill bundle:

- `programming`
  - `execute_code`
- `file-management`
  - `write_file`
  - `read_file`
  - `list_files`
  - `delete_file`

Any agent that should have aitradingbot-equivalent programming power receives both skills.

## Scope

### In scope

1. Replace the Herobids `programming` skill definition with a narrow execution skill.
2. Add a separate built-in `file-management` skill.
3. Add filesystem agent tools in the worker and shared tool catalog.
4. Expand `execute_code` to support JavaScript, Python, dependencies, and richer results.
5. Add workspace semantics that persist across ticks within a runtime.
6. Update the runtime image and execution path to support Python and dependency installation.
7. Add focused tests for the new tool contracts and workspace behavior.
8. Update DB-seeded system skill content so persisted system skills match code.

### Out of scope

1. General-purpose host filesystem access outside the workspace root.
2. A web UI for editing workspace files.
3. New language runtimes beyond JavaScript and Python.
4. Separate code-execution sidecars or services.
5. A compatibility layer preserving the old Herobids `programming` skill surface.
6. Preset naming alignment between `personal-assistant` and `reminder`; that is tracked separately.

## Target Behavior

### Programming skill

The `programming` skill should mean:

- The agent can write and run JavaScript or Python.
- The agent can install packages needed for analysis.
- The agent can read back execution output from stdout and stderr.
- Workspace files are available when the separate `file-management` skill is attached.

### File-management skill

The `file-management` skill should mean:

- The agent can create, inspect, list, and delete workspace files.
- The agent understands that workspace files persist across ticks in the same runtime.
- The agent understands that workspace files do not persist across runtime restarts.
- Durable cross-restart data still belongs in memory tools, not workspace files.

### Workspace contract

- Logical workspace root: `/workspace`
- Execution scratch directory: `/workspace/sandbox`
- User-managed workspace files: any path under `/workspace` except reserved execution directories
- Persistence guarantee:
  - persists across ticks for the current runtime or container
  - does not persist across runtime or container restart
- In Docker mode:
  - `/workspace` lives on the container filesystem
- In stub mode:
  - emulate the same behavior with a per-agent local workspace root so development behavior remains available

### Code execution contract

- `execute_code` supports:
  - JavaScript via `node`
  - Python via `python3`
- optional dependency installation:
  - JavaScript: write `package.json`, run `npm install --no-audit --no-fund`
  - Python: write `requirements.txt`, run `pip install --target ...`
- execution result includes:
  - `stdout`
  - `stderr`
  - `exitCode`
  - `durationMs`
- nonzero exit code returns `success: false` with structured output included
- executed code keeps public internet availability when sandboxing is present
- if the sandbox wrapper is unavailable, execution still proceeds rather than being disabled

## Exact Skill Definition Changes

### File

- `packages/domain/src/skills.ts`

### Replace `PROGRAMMING_SKILL` with

```ts
export const PROGRAMMING_SKILL: SkillDefinition = {
  id: 'programming',
  name: 'Programming',
  description: 'Code execution tools',
  instructions: `You have access to programming tools for code-driven automation, external API calls etc.

- You can use \`execute_code\` to run JavaScript or Python for custom automation, external API calls, analysis, data processing etc.
- The tool supports JavaScript/Node.js and Python runtimes as well as optional dependency installation.
- The tool returns stdout/stderr so you can inspect execution results directly.

Important constraints:
- Code can access the public internet.
- If you also have the file-management skill, workspace files are available for intermediate state across ticks.
- For data that must survive runtime restarts, memory tools from the base skill are the durable storage path.`,
  requiredTools: ['execute_code'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};
```

### Add `FILE_MANAGEMENT_SKILL`

```ts
export const FILE_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'file-management',
  name: 'File Management',
  description: 'Manage a per-agent workspace for intermediate files and outputs.',
  instructions: `You have access to workspace file-management tools.

- You can use \`write_file\` to create or overwrite a file under the agent workspace.
- You can use \`read_file\` to inspect file contents.
- You can use \`list_files\` to inspect workspace directories and discover available files.
- You can use \`delete_file\` to remove files you no longer need.

Workspace rules:
- Workspace files persist across ticks in the same runtime.
- Workspace files do not persist across runtime restarts.
- The \`sandbox\` directory is reserved for code execution internals.
- For data that must survive runtime restarts, memory tools from the base skill are the durable storage path.`,
  requiredTools: ['write_file', 'read_file', 'list_files', 'delete_file'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};
```

### Notes

- Do not list `send_message` and `publish_artifact` in these skills.
- Those already come from `BASE_SKILL`, which is auto-injected in Herobids.
- This keeps both skills incremental and consistent with the skill authoring rule that skills stay narrowly scoped.
- Any agent that should match aitradingbot's combined programming capability gets both `programming` and `file-management`.

## Exact Shared Tool Catalog Changes

### File

- `packages/domain/src/tools.ts`

### Change `ToolCategory`

Add filesystem read and write categories:

```ts
export type ToolCategory =
  | 'read-database'
  | 'read-memory'
  | 'read-market-data'
  | 'read-trade'
  | 'read-web'
  | 'read-filesystem'
  | 'write-database'
  | 'write-memory'
  | 'write-messaging'
  | 'write-filesystem'
  | 'execute-trade'
  | 'execute-filesystem';
```

### Change category docs

Add examples:

- `read-filesystem` - `read_file`, `list_files`
- `write-filesystem` - `write_file`, `delete_file`
- `execute-filesystem` - `execute_code`

### Change `KNOWN_AGENT_TOOL_NAMES`

Add these tool names:

```ts
'delete_file',
'list_files',
'read_file',
'write_file',
```

Keep the catalog ordering alphabetical or near-alphabetical.

## Exact Tool Schema Changes

### File

- `apps/worker/src/tools/code.ts`

### Replace the current params schema with

```ts
const CodeExecuteParamsSchema = z.object({
  code: z.string().min(1),
  language: z.enum(['javascript', 'python']).default('javascript'),
  dependencies: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  description: z.string().optional(),
});
```

### Replace the tool description with

```ts
description: 'Execute JavaScript (Node.js) or Python code in a workspace-backed environment. Supports optional package installation and returns stdout, stderr, exit code, and duration.',
```

### Execution result shape

Successful result:

```ts
{
  success: true,
  data: {
    stdout: string,
    stderr: string,
    exitCode: 0,
    durationMs: number,
  },
}
```

Failure result for code or runtime errors:

```ts
{
  success: false,
  data: {
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
  },
  error: string,
  retryable?: boolean,
}
```

### New execution behavior

1. Derive workspace root.
   - Docker mode default: `/workspace`
   - Stub mode: a per-agent local directory, for example `/tmp/herobids-agent-workspaces/<agentId>`
   - This must be hidden behind a helper so tools and runtime agree

2. Use reserved sandbox directory:
   - `${workspaceRoot}/sandbox`

3. Build entrypoint based on language:
   - JavaScript:
     - write `script.js`
     - if dependencies exist, write `package.json`
   - Python:
     - write `script.py`
     - if dependencies exist, write `requirements.txt`

4. Build shell command:
   - JavaScript with deps:
     - `cd <sandbox> && npm install --no-audit --no-fund 2>&1 && node script.js`
   - JavaScript without deps:
     - `cd <sandbox> && node script.js`
   - Python with deps:
     - `cd <sandbox> && pip install --target <sandbox>/.pylibs -q -r requirements.txt 2>&1 && PYTHONPATH=<sandbox>/.pylibs python3 script.py`
   - Python without deps:
     - `cd <sandbox> && python3 script.py`

5. Run the command through the sandbox path when available.
   - Recommended invocation: `sandbox-exec.sh sh -lc "<command>"`
   - If the sandbox wrapper is unavailable, run the same shell command directly.

6. Keep output limits and timeouts.
   - Truncate `stdout` and `stderr`
   - Respect the lower of:
     - explicit `timeoutMs`
     - capability policy timeout if present
     - runtime default timeout

7. Keep lightweight dependency-name validation.
   - Reject obviously unsafe dependency strings.
   - Do not remove dependency installation support.

### File

- create `apps/worker/src/tools/filesystem.ts`

### Add four new tools

These tools belong to the separate `file-management` skill, not to the `programming` skill.

#### `write_file`

Schema:

```ts
const WriteFileParamsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
```

Behavior:

- path is relative to the workspace root
- create parent directories as needed
- reject writes to reserved execution directories such as `sandbox`
- return bytes written

#### `read_file`

Schema:

```ts
const ReadFileParamsSchema = z.object({
  path: z.string().min(1),
});
```

Behavior:

- path is relative to the workspace root
- may read from normal workspace files and from `sandbox` outputs
- reject directories
- reject oversized files above the configured cap

#### `list_files`

Schema:

```ts
const ListFilesParamsSchema = z.object({
  path: z.string().optional().default(''),
});
```

Behavior:

- list files and directories under the workspace root
- return directory names with `/` suffix for readability

#### `delete_file`

Schema:

```ts
const DeleteFileParamsSchema = z.object({
  path: z.string().min(1),
});
```

Behavior:

- path is relative to the workspace root
- reject deletes in reserved execution directories such as `sandbox`
- only delete files, not directories

### Shared filesystem rules

- enforce workspace-root path validation
- reject `..`
- resolve symlinks and reject any path escaping the workspace root
- reserve `sandbox` from user writes and deletes
- allow reading from `sandbox` so code outputs can be inspected

These checks preserve parity and remove only avoidable filesystem risk.

## Exact Worker Registration Changes

### Files

- `apps/worker/src/tools/index.ts`
- `apps/worker/src/tools/tool-registry.test.ts`

### Required changes

1. Register the new filesystem tools in the worker tool registry.
2. Ensure `execute_code`, `write_file`, `read_file`, `list_files`, and `delete_file` all appear in the final tool registry.
3. Update registry tests to assert:
   - the new tools are registered
   - built-in programming skill tools all resolve against the shared manifest
   - built-in file-management skill tools all resolve against the shared manifest

## Exact Runtime Changes

### File

- `docker/Dockerfile.agent`

### Change runtime image dependencies

The runtime image must include:

- `python3`
- `py3-pip`
- existing network sandbox tooling:
  - `iproute2`
  - `iptables`
  - `ip6tables`

Recommended runtime package install line:

```dockerfile
RUN apk add --no-cache iproute2 iptables ip6tables python3 py3-pip
```

### Workspace directory

Add a workspace root in the runtime image:

```dockerfile
RUN mkdir -p /workspace /workspace/sandbox
```

This directory persists across ticks for the life of the container and disappears when the container is removed, which matches the target contract.

### File

- `apps/worker/src/agents/docker-agent-manager.ts`

### Optional runtime env additions

Inject a workspace env var so tools can share one source of truth:

- `AGENT_WORKSPACE_ROOT=/workspace`

This is recommended even though Docker mode can default to `/workspace`, because it makes stub-mode parity cleaner.

### File

- `scripts/sandbox-exec.sh`

### Sandbox invocation compatibility

No fundamental security redesign is required here. What is required is compatibility with shell-command execution for:

- `cd ...`
- `npm install && node script.js`
- `pip install && python3 script.py`
- environment variable prefixes like `PYTHONPATH=...`

Recommended implementation choice:

- leave the script generic
- invoke it as `sandbox-exec.sh sh -lc "<command>"`

That avoids changing the sandbox wrapper contract more than necessary.

### File

- `apps/worker/src/tools/code.ts`

### Workspace helper

Introduce a small helper used by both `code.ts` and `filesystem.ts`, for example:

- create `apps/worker/src/tools/workspace.ts`

Responsibilities:

1. resolve workspace root
2. derive sandbox directory
3. ensure directories exist
4. perform path validation against the workspace root
5. centralize reserved directory rules

Recommended API shape:

```ts
export interface WorkspacePaths {
  root: string;
  sandbox: string;
}

export function getWorkspacePaths(agentId: string): WorkspacePaths;
export function resolveWorkspacePath(root: string, relativePath: string):
  | { ok: true; absolutePath: string }
  | { ok: false; error: string };
```

### Stub-mode parity

Herobids dev mode still supports `stub` launcher mode in `apps/worker/src/agents/agent-runtime-launcher.ts`.

To preserve parity in local development:

- use a per-agent workspace root such as `/tmp/herobids-agent-workspaces/<agentId>`
- persist that directory across ticks while the worker process stays alive
- do not disable filesystem or code tools in stub mode

This is an implementation requirement, not a nice-to-have, because parity includes availability during development.

## DB Sync Changes

### Why this is needed

Herobids stores system skills in the `skills` table as well as in code. Changing `packages/domain/src/skills.ts` alone is not enough if DB system rows remain stale.

### Required implementation

Ship one of these with this feature:

1. preferred:
   - implement or land system-skill startup sync so `SYSTEM_SKILLS` always upserts into DB on API startup
2. acceptable:
   - add a DB migration that updates the persisted `programming` and `file-management` skill rows

Because backward compatibility is explicitly out of scope, no dual-shape migration strategy is needed.

### Exact persisted system skill shapes

The stored system skill row for `id = 'programming'` must match:

- new description
- new instructions
- `required_tools = ['execute_code']`

The stored system skill row for `id = 'file-management'` must match:

- new description
- new instructions
- `required_tools = ['write_file', 'read_file', 'list_files', 'delete_file']`

## Tests

### Code tool

Add tests covering:

1. JavaScript execution succeeds and returns structured output.
2. Python execution succeeds and returns structured output.
3. JavaScript dependency install path works.
4. Python dependency install path works.
5. Explicit timeout is respected.
6. Stdout and stderr are truncated to configured caps.
7. Nonzero exit code returns `success: false` with structured output.
8. Repeated calls can read prior workspace files across ticks.

### Filesystem tools

Add tests covering:

1. write then read round-trip
2. list root and nested directories
3. delete file
4. reserved `sandbox` write rejection
5. reserved `sandbox` delete rejection
6. reading a file from `sandbox` succeeds
7. path traversal with `..` is rejected
8. symlink escape is rejected

### Registry and skill validation

Add tests proving:

1. tool registry includes all five programming-related tools
2. `PROGRAMMING_SKILL.requiredTools` matches the registered tools
3. `FILE_MANAGEMENT_SKILL.requiredTools` matches the registered tools
4. shared tool-name manifest includes the new filesystem tool names

## Verification commands

- `pnpm lint`
- focused worker tests for tools and registry
- any existing system-skill validation tests

## Implementation Plan

1. Update the shared tool catalog in `packages/domain/src/tools.ts`.
   Change: add filesystem categories and tool names.
   Dependency: none.

2. Replace the `programming` skill definition in `packages/domain/src/skills.ts`.
   Change: new instructions, new description, and `requiredTools = ['execute_code']`.
   Dependency: step 1.

3. Add the built-in `file-management` skill in `packages/domain/src/skills.ts`.
   Change: add a new narrow skill for `write_file`, `read_file`, `list_files`, and `delete_file`.
   Dependency: step 1.

4. Add shared workspace helpers in worker code.
   Files: new `apps/worker/src/tools/workspace.ts`.
   Change: workspace-root resolution, path validation, reserved-dir logic.
   Dependency: none.

5. Add filesystem tool implementations.
   Files: new `apps/worker/src/tools/filesystem.ts`.
   Change: implement `write_file`, `read_file`, `list_files`, and `delete_file`.
   Dependency: steps 1, 3, and 4.

6. Expand `execute_code` to parity shape.
   Files: `apps/worker/src/tools/code.ts`.
   Change: language selection, dependencies, timeout, structured results, workspace-backed execution.
   Dependency: steps 1 and 4.

7. Register the new tools.
   Files: `apps/worker/src/tools/index.ts`.
   Change: add filesystem tool exports to the registry.
   Dependency: steps 5 and 6.

8. Update the runtime image.
   Files: `docker/Dockerfile.agent`, optionally `apps/worker/src/agents/docker-agent-manager.ts`.
   Change: install Python and pip, create `/workspace`, optionally inject `AGENT_WORKSPACE_ROOT`.
   Dependency: step 6.

9. Ensure shell-command compatibility for sandbox execution.
   Files: `apps/worker/src/tools/code.ts`, optionally `scripts/sandbox-exec.sh`.
   Change: run `sh -lc` commands inside the sandbox path when available.
   Dependency: step 6.

10. Sync the persisted system skill rows.
    Files: API startup sync path or DB migration path.
    Change: persisted `programming` and `file-management` skill rows must match code.
    Dependency: steps 2 and 3.

11. Add focused tests.
    Files: code tool tests, filesystem tool tests, registry tests, any system-skill tests.
    Dependency: steps 5 through 10.

## Exit Criteria

- The `programming` skill in `packages/domain/src/skills.ts` exposes only `execute_code`.
- A separate `file-management` skill in `packages/domain/src/skills.ts` exposes `write_file`, `read_file`, `list_files`, and `delete_file`.
- `execute_code` supports JavaScript and Python.
- `execute_code` supports dependency installation.
- Agents can persist workspace files across ticks within the runtime.
- Filesystem tools are registered and validated like any other built-in tool.
- Runtime image includes Python and pip.
- Persisted system skill data matches the code definitions.
- Focused tests and `pnpm lint` pass.
