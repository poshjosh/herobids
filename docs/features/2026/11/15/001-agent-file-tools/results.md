# Results: agent file tools

## WP1. Foundation (done, not committed)

Checks: focused tests pass; `pnpm lint`, `pnpm test` (448 files, 8,512 tests) and `pnpm build` pass.

### What was added

- Config: `FileToolsConfigSchema`, `WebCacheConfigSchema` (exported from `@herobids/domain`), `sandboxDefaults.workspaceDiskMb`, optional profile `workspaceDiskMb`, `tools.files`, `webAccess.webCache`. `browseUrl.maxResponseBytes` default is now 1 MiB. `default.yaml` has all keys with comments (free 100, starter 100, pro 500 MiB).
- `RuntimeResourceProfile.workspaceDiskMb?`; launcher resolves it (profile, then default) and sets `AGENT_WORKSPACE_QUOTA_MB`; `index.ts` `defaultResources` carries it; env var added to `IGNORED_ENV_VARS`.
- Worker modules: `file-limits.ts`, `file-text.ts`, `workspace-quota.ts`, `tool-signature.ts`, `file-messages.ts`, each with tests. Config schema tests in `packages/domain/src/config/file-tools-config.test.ts`.

### Decisions and deviations

1. Launcher env order: the env build moved after the profile is resolved. The quota env var is only set when the launcher builds the env (`envConfig` present). On the legacy path the env stays `{}`, because the Docker adapter treats an empty env as "use my own defaults" and one extra key would change that.
2. Surrogate pairs: counting by code points means a page can never split a pair, so the plan's "page is one character shorter" rule is not needed.
3. `read_file_lines` `truncated` (when WP2 builds it): `readLinePage` returns `lineCut` and `nextLine`. A cut last line has `lineCut: true` and `nextLine: null`; WP2 should report `truncated` as `nextLine !== null || lineCut` so a cut is never reported as complete.
4. Signatures: `tool-signature.ts` uses a static map (`FILE_TOOL_PARAMS`) to avoid an import cycle. It is guarded by `tool-signature.test.ts`, which compares each entry with the real Zod schema. Tools that change in later WPs (`read_file`, `list_files`, `delete_file`, `browse_url`, and the four new tools) are listed in `NOT_YET_IMPLEMENTED` in that test. The test fails once a listed tool's schema matches the map, so each WP must remove its tools from that list.
5. Added `toolUse(name, ...argNames)` (short form such as `search_files(path, query)`, checked against the map) next to `toolSignature` and `toolCall`. The plan templates use the short form; the full `toolSignature` form was too long for the 350 character limit.
6. `findSignatureProblems(text)` in `tool-signature.ts` is the text drift check for skill instructions and docs (WP7 should call it on `FILE_MANAGEMENT_SKILL.instructions` and `file-tools.md`).
7. Long paths in messages are shortened to 60 characters (tail kept, leading `…`). A call example built from a shortened path is not callable; the agent knows its real path. Done to keep every message at most 350 characters (tested). The paging hints (not errors) use the full path.
8. `file.quota_exceeded` walk-cap message names the largest top-level folder in `delete_file(...)` (or `<dir>` if none).
9. `getFileToolLimits()` throws if `tools.files` is present but invalid (config error is fatal); missing or unreadable JSON falls back to schema defaults.
10. `NODE_ENV === 'test'` decides strict mode in `toolSignature`/`toolCall`. `VITEST` cannot be used because the env drift test requires every `process.env[...]` literal to be in `.env.example`.
11. Quota walk: files are counted when seen, the cap trips when a file beyond `quotaWalkMaxFiles` exists (exactly the cap is fine). Empty top-level folders still appear in `topDirs` with 0 bytes.

### Measured

- 10 MiB single-pass `readCharPage` scan (page in the middle): 68 ms on this machine (plan assumed tens of ms).

### Unverified / left for later WPs

- `fromFsError` and the hint functions are not yet used by any tool (WP2 to WP6).
- `AGENT_WORKSPACE_QUOTA_MB` reaching a real container was not checked (no live stack; launcher unit tests only).
