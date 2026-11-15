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

## WP2. Read side (done, not committed)

Checks: focused tests (`file-read-tools.test.ts`, 29 tests, plus updated `filesystem.test.ts`, `file-messages.test.ts`, `tool-signature.test.ts`); `pnpm lint`, `pnpm test` (449 files, 8,541 tests) and `pnpm build` pass.

### What was added

- `read_file`: `offset` and `limit` (code points), streamed by `readCharPage`; result `path, offset, returnedChars, totalChars, totalLines, nextOffset, truncated, hint?, content`. Default page `readDefaultChars`, max `readMaxChars`; files up to `maxFileBytes` open. The 1 MiB constant is gone.
- `read_file_lines` (new module `read-file-lines.ts`, re-exported through `filesystemTools`): `truncated = nextLine !== null || lineCut`; when a line is cut the hint points to `read_file(path, offset: lineStartOffset + returned chars)`.
- `list_files`: `offset`, `limit`, `totalEntries`, `nextOffset`, `truncated`, `hint?`; `limit` over `list.maxEntries` gives `file.limit_too_large`.
- `file-access.ts`: shared `resolveReadableFile` (path check, regular-file check, size cap) used by both read tools. Reads of `sandbox/` stay allowed.
- Wiring: `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG` (new `read_file` text), `FILE_MANAGEMENT_SKILL` and `LONG_RUNNING_TASK_SKILL` `requiredTools`, one `read_file_lines` instruction line, both `WORKSPACE_CONTEXT_TOOL_NAMES` sets (also `stat_file`). `read_file_lines`, `read_file` and `list_files` removed from `NOT_YET_IMPLEMENTED`.
- WP1 outstanding items fixed: call examples in `file-messages.ts` use the full path; `workspace-quota.ts` handles ENOENT per directory and per file (only a missing root counts as an empty workspace).

### Decisions and deviations

1. New code `file.not_a_directory` (`list_files` on a file, was an inline `path is a file, not a directory`). Not in the plan table; added so no tool builds a message inline.
2. Old inline error strings of the read tools are replaced by the `file-messages.ts` messages (Design 0a). `file not found` is now `File not found: ...` (existing `/not found/` assertion still holds). The path-escape test now asserts `errorCode: 'file.path_invalid'` instead of the old `traversal|escapes` text, because `pathInvalid` has one message for all invalid-path causes.
3. To keep every message at most 350 characters with full-path call examples, `isDirectory` now starts `That path is a directory.` (no repeated path), `deleteTooMany` is shorter, and the long-path test uses a 3-fold path (about 85 chars, still longer than the 60 character display cut) instead of a 280 character one. A path of about 100 characters or more can push call-example messages over 350; accepted, since a callable path matters more.
4. `limitTooLarge` has `forList` so the `list_files` limit message points to paging, not to `read_file_lines`.
5. Descriptions interpolate limits and companion signatures (`search_files` is named although it ships in WP5, as the message templates already do).
6. The capability manifest doc (`docs/features/pending/000-capability-foundations/009-...md`) has an exhaustive tool table checked by `providers.test.ts`; a `read_file_lines` row was added. WP4, WP5 need the same for their tools.
7. `platform-docs-data.ts` / `build-docs-index.ts` not touched (WP7).

### Unverified

- No test for a folder vanishing mid-walk in `workspace-quota.ts` (race hard to stage); the per-directory ENOENT handling is covered only by the existing missing-root test.
- Prompt-cost measure for the new schemas is left for WP7.

## WP3. Truncation marker and `maxToolResultChars` documentation (done, not committed)

Checks: focused tests (`structured-tool-loop.test.ts`, new `stale-result-hints.test.ts`, new `RuntimePolicySection.dom.test.tsx`); `pnpm lint`, `pnpm test` and `pnpm build` pass.

### What was added

- `structured-tool-loop.ts`: stale marker is now `...[cut: kept 1,000 of 10,119 chars]` (en-US thousands separators). New option `describeCutResult({ toolName, args, originalContent })`; when it returns text the marker reads `...[cut: kept N of M chars. <hint>]`. The loop records `toolCall.args` by call id when it pushes the assistant message. `onToolResultTruncated` fields are unchanged.
- `stale-result-hints.ts`: `describeCutResult` with `read_file` and `read_file_lines` rows only (path from the original call args; no hint if the path is missing or not a string). Hint text is `staleReadHint(path)` in `file-messages.ts`, built with `toolCall()`.
- `agent.ts`: `describeCutResult` passed at the scout and judge loop call sites.
- Old marker assertions in `structured-tool-loop.test.ts` updated (three assertions, one comment); new tests for sizes, hint with args, and no hint.
- `maxToolResultChars` documented only (no behaviour change): comments in `default.yaml`, JSDoc in `runtime-composition.ts` and `schema.ts`; help line `agents.runtimePolicy.maxToolResultCharsHelp` in en/ar/hi, rendered under the field in `RuntimePolicySection.tsx`.

### Decisions and deviations

1. Hint is placed inside the bracket after the sizes (`...[cut: kept 20 of 100 chars. Read it again with ...]`) so the marker stays one unit.
2. The hint wording is one fixed string: `read_file_lines(path, startLine: 1, limit: 200)` or `read_file(path)`. The plan's example named only the first call; both are named because Design 10's table names both tools.
3. A throwing `describeCutResult` is not caught (the shipped one cannot throw: pure string checks). A caught error would have been swallowed silently, against `AGENTS.md`.
4. Added a small DOM test for the help line (no component test existed). The Arabic and Hindi strings are my translations of the owner's English wording; a native review is advisable.
5. Search/browse rows and their tests land with WP5/WP6.

### Unverified

- Older docs that describe `...[truncated]` as history were left as the plan says.
- No live check of the marker in a real agent run.
