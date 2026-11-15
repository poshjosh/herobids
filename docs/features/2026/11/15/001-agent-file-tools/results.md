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

## WP4. Write side (done, not committed)

Checks: focused tests (`file-write-tools.test.ts`, 47 tests; `filesystem.test.ts`, `tool-signature.test.ts`, `file-messages.test.ts`); `pnpm lint`, `pnpm test` (452 files, 8,597 tests) and `pnpm build` pass.

### What was added

- `file-write.ts`: `resolveWritableTarget` (reserved dir, path safety, directory and non-regular-file refusal, existing size/mode/owner), `checkWriteChars` (`writeMaxChars`, code points), `checkWriteBudget` (`maxFileBytes`, then soft quota on net growth only), `writeFileAtomic` (temp file `.write-<uuid>.tmp` with `wx`, mode copy, best-effort `chown` with a warn log, `rename`, temp removed on error).
- `append_file` (`append-file.ts`), `edit_file` (`edit-file.ts`), `delete_file` (`delete-file.ts`, now with `recursive`), all re-exported through `filesystemTools`. `write_file` stays in `filesystem.ts` with the cap, size and quota checks and new description.
- Wiring: `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG` (new `append_file`, `edit_file`; updated `write_file`, `delete_file` text), `FILE_MANAGEMENT_SKILL` and `LONG_RUNNING_TASK_SKILL` `requiredTools`, instruction lines for `append_file`, `edit_file` and `delete_file(recursive)`, both `WORKSPACE_CONTEXT_TOOL_NAMES` sets, two rows in the capability manifest doc. `append_file`, `edit_file`, `delete_file` removed from `NOT_YET_IMPLEMENTED`.

### Decisions and deviations

1. New code `file.not_text` (message `notText`): `edit_file` on a file that is not valid UTF-8 is refused, because rewriting it would turn bad bytes into U+FFFD and corrupt it. Not in the plan's code table. Check: re-encoding the decoded text must equal the original bytes.
2. `deleteTooMany(path, max)` no longer takes a file count. The walk stops as soon as the count passes `maxDeleteFiles`, so the real total is unknown; the message says "more than <max> files". The WP1 message test was changed to match.
3. `notAFile(path, action)` takes `'read' | 'written'` so a write to a FIFO does not say "cannot be read".
4. `delete_file` protected paths: the workspace root (also via `.`, `./`, `notes/..`) and the exact top-level `platformDirs` entries give `file.reserved_path` with the "managed by the platform" message. Paths inside `.agents`, `.claude` or `agent` can still be deleted (as before; the plan lists only the directories). `sandbox/...` keeps the old "reserved" message (`reservedPath`), which the existing test matches.
5. `delete_file` uses `lstat`: a symlink path is unlinked (counts 1 file, 0 bytes freed). A symlink whose target is outside the workspace is still refused by `resolveWorkspacePath` (`file.path_invalid`), as before. Symlinks inside a recursively deleted folder count as files and are removed as links.
6. `delete_file` failure part-way through `fs.rm` returns the mapped fs error without a "deleted so far" count (not tracked; plan said "if known").
7. `append_file`: an empty `content` never adds a lone newline. `bytesAppended` includes the added newline byte. A call that adds no bytes skips the quota walk.
8. `edit_file` on an in-workspace symlink writes the temp file next to the real target (`realpath`), so the link stays a link and the target is edited. Replacement uses `indexOf` and slicing, never `String.replace`, so `$&` in `newText` is literal. `oldText === newText` is checked before the file is opened.
9. Quota check runs only when the net growth is above zero (`write_file` overwrite, `edit_file`, `append_file`), so shrinking or same-size edits still work when the workspace is full or the walk cap is hit.
10. Limits that tests change (`maxFileBytes`, `writeMaxChars`, `maxDeleteFiles`, `platformDirs`) are read with `getFileToolLimits()` at call time; module-level values are used only for tool descriptions and parameter text.
11. `write_file` keeps a plain `writeFile` (not atomic); the plan asks for the atomic helper only for `edit_file`.

### Measured / unverified

- Editing a file of exactly 10 MiB (in-memory replace plus atomic write) takes about 20 ms in the test; peak memory was not measured (plan item "WP4 measures it" is open).
- `chown` preservation cannot be proven in unit tests (runs as a normal user); the mode copy is tested. Live check needed in the container (root runtime, file made by user `agent`).
- `delete_file` descriptions and the audit table row were not updated here (docs are WP7); the catalog text was.
- Not done in WP4 on purpose: `file-tools.md`, audit rows, CHANGELOG, platform docs index (WP7).

## WP5. `search_files` (done, not committed; status row stays PENDING)

Checks: focused tests (`search-files.test.ts`, 42 tests, run three times with no flake; `file-messages.test.ts`, `tool-signature.test.ts`, `stale-result-hints.test.ts`); `pnpm lint`, `pnpm test` (453 files passed, 8,642 tests passed, 48 files skipped as before) and `pnpm build` pass.

### Decision: regex ships (no literal-only fallback)

Regex was attempted with the worker design and works, so none of the fallback criteria in Design 3 applies:
- (a) The worker runs from an `eval: true` CommonJS string (`line-matcher.ts`), so there is no extra file to resolve. It runs under vitest here. The built `dist/tools/line-matcher.js` also runs under plain `node` (a regex matcher created and closed, worker count back to 0). Not checked: `tsx` dev and the agent container image (no live stack); it uses only `node:worker_threads`, so I expect no difference.
- (b) `worker.terminate()` stopped `(a+)+$` on a 40-character line within the 400 ms test deadline (total test time about 400 ms), and the worker count returns to 0.
- (c) The timeout test passed on all runs (3 repeated runs plus the first run), no flakiness.

### What was added

- `line-matcher.ts`: `createLiteralMatcher` (main thread) and `createRegexMatcher` (one worker per search, created on the first batch, `maxOldGenerationSizeMb` 64, terminated on timeout, error, exit or `close()`). `getActiveRegexWorkerCount()` for tests.
- `search-scan.ts`: `SearchRun` (sorted depth-first walk, symlinks never followed, batching of 500 lines / 256 K characters, limits, context lines, match windows, character offsets).
- `search-files.ts`: the tool, registered in `filesystemTools` (category `read-filesystem`, so the scout gets it with no code change).
- Wiring: `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG`, `FILE_MANAGEMENT_SKILL` (requiredTools plus one instruction line) and `LONG_RUNNING_TASK_SKILL.requiredTools`, both `WORKSPACE_CONTEXT_TOOL_NAMES` sets, `search_files` removed from `NOT_YET_IMPLEMENTED` in `tool-signature.test.ts`, a `search_files` row (`core`) in the capability manifest doc, and the `search_files` row in `stale-result-hints.ts` (`staleSearchHint()` in `file-messages.ts`).
- Messages: `searchStopReason()` (plain-words reason for the incomplete hint), `staleSearchHint()`, and `limitTooLarge(..., { forSearch: true })`.

### Decisions and deviations

1. Case-insensitive literal search uses an escaped pattern with the `i` flag on the main thread, not `indexOf` on lower-cased text as Design 3 says. Lower-casing can change a string's length, which makes the match index wrong; the escaped literal cannot backtrack, so it needs no worker.
2. One match is reported per line (the first). The plan's result shape has one `offset` and one `line` per match, and a second match on the same line would only repeat the pointer. Stated in the tool description.
3. `max_matches` is only reported when a match beyond the limit exists (the search reads on to find it). `stoppedAt` is that extra match's line. With exactly `maxMatches` matches the result is complete. This differs from the plan's looser "there may be more".
4. The text cap is `defaultResultChars` (8,000) when `maxMatches <= defaultMatches`, and `readDefaultChars` (50,000) when the agent asks for more. It counts the JSON size of each match; the "after" context lines are added later and can pass the cap by a few hundred characters. A single match is always returned even if it alone passes the cap.
5. `query` length, `maxMatches`, `contextLines` and the regex pattern length are checked in the tool body against config (they are config values, so not in the static Zod schema). The first three return `file.limit_too_large` (new `forSearch` wording); a pattern that is too long returns `search.invalid_pattern` with the numbers. A multi-line query is refused by the Zod schema (`/^[^\r\n]+$/`).
6. A worker error (for example out of memory) is reported as `regex_timeout` after a warn log. The plan's reason list has no separate value and the effect for the agent is the same (stop, narrow the pattern).
7. Regex flags are `i` only (no `u`), so patterns that are valid JavaScript without the Unicode flag work. `.` can therefore match half of a surrogate pair; offsets are converted to code points so they stay correct.
8. A start path that is a file larger than `maxFileBytes` returns `file.too_large` (more useful than a silent skip). Files over the limit found during a folder walk are skipped and counted in `skippedLarge`.
9. A folder or file that cannot be read during the walk (vanished, permission denied) is skipped with a warn log; the search goes on. Only the start path's errors are returned to the agent (`fromFsError`).
10. Lines split on `\n`; a trailing `\r` is removed from the returned text and from regex input so `$` works on CRLF files.
11. `search_files` stale hint is one fixed string with no dependency on the call args (Design 10: "run again with a narrower query or path").

### Measured / unverified

- Catastrophic pattern `(a+)+$` on `a` x 40 + `b`: stopped at the 400 ms test deadline; worker count 0 afterwards.
- A 5 MiB single-line file is searched with a literal query in the test (about 40 ms, same test run).
- Not verified: worker start-up cost in the container (not measured separately) and any live agent use. Prompt-cost measure of the new schema is left for WP7.
- Not done here on purpose: `file-tools.md`, audit rows, CHANGELOG, platform docs index, signature drift check of skill instructions (WP7).

## WP6. `browse_url` and the web cache (done, not committed; status row stays PENDING)

Checks: focused tests (`web-access-browse.test.ts` 22 tests, `web-access.test.ts`, `web-access-denial-log.test.ts`, `stale-result-hints.test.ts`, `tool-signature.test.ts`, `capability-policy.test.ts`, `file-messages.test.ts`); `pnpm lint`, `pnpm test` (454 files passed, 8,667 tests passed, 48 files skipped as before) and `pnpm build` pass. No live stack, no infrastructure change, no automatic file deletion.

### What was added

- Default grant: `maxResponseBytes` removed from the `browse_url` grant (`capability-policy.ts`), so `tools.webAccess.browseUrl.maxResponseBytes` (1 MiB) now governs. A per-agent `tool_policy` still wins.
- `browse_url` (`web-access.ts`): new `limit` param (coerced, `>= 1`; the maximum `readMaxChars` is checked in the body and gives `file.limit_too_large`, before the capability grant is used and before any fetch). Result key order: `url, title, truncated, sourceTruncated, totalChars, returnedChars, nextOffset, savedTo?, saveError?, hint?, content`. `truncated` now means "the inline text is cut"; the old meaning ("fetch cap hit") moved to `sourceTruncated`. Description states the units, the saved copy, companion tools (`toolUse`) and that page text is untrusted.
- `web-cache.ts` (new): `webCacheFileName` (`<host-slug>-<sha256(finalUrl)[0..12]>.txt`) and `saveToWebCache`. Order: `sizeMb: 0` skips silently, cache cap (net growth for the same URL), workspace quota (`assertWithinQuota`), atomic write (`writeFileAtomic`). Nothing is ever deleted.
- Messages (`file-messages.ts`): `browseSaveFailedText()` (non-capacity save failure), `staleBrowseHint(savedTo)`. The continue hint reuses `readFilePagedHint(savedTo, nextOffset)`. `browseSaveErrorText()` already existed from WP1.
- `stale-result-hints.ts`: `browse_url` row. It parses the original result with a guarded `JSON.parse` and gives a hint only when `savedTo` is present.
- `tool-signature.test.ts`: `browse_url` removed from `NOT_YET_IMPLEMENTED` (the set is now empty and kept for later use).
- `read_document` shares the raised cap with no code change to its logic (it reads the same config key). Its fallback literal `512 * 1024` was replaced by the schema default (see 2).

### Decisions and deviations

1. When the page fits one page, `nextOffset` is `null` and nothing is written. When it does not fit and saving is skipped or fails, `nextOffset` is `null` too (it is only an offset into the saved file).
2. The fetch-cap fallback literal in `browse_url` and `read_document` (`512 * 1024`) now comes from `WebAccessToolsConfigSchema.shape.browseUrl.parse(undefined)`, so the default lives only in the Zod schema (1 MiB). `search_web` is unchanged (still 256 KiB).
3. A save failure that is not "cache or workspace full" (for example a permission error, or the cache path failing the workspace path check) is logged at warn level and returned as `saveError` using the new `browseSaveFailedText()`. The tool still succeeds with the first page. The plan names only the full-cache and quota cases; this keeps the other failures visible to the agent and in logs instead of failing the whole fetch.
4. The cache folder size counts regular files directly inside `web-cache/` (non-recursive; the tool only writes there). A leftover `.write-<uuid>.tmp` from a crash counts, and the agent can delete it.
5. Cached files are written by the runtime (root in the container) with default mode, so sandboxed code can read but not modify them. No chown (the plan asks for none).
6. `limit` is validated before `checkAccess`/`recordStart`, so a bad limit does not use up a rate-limit slot. This differs from the other `browse_url` errors, which come after `recordStart`.
7. The inline page is cut by code points (`sliceCodePoints`), so a surrogate pair is never split. A page cut by the byte cap (`Buffer.slice` + `toString`) can still end in U+FFFD, as before.
8. `maxResponseBytes` is read at module load in `web-access.ts` (existing behaviour), so the config-cap test uses `vi.resetModules()` and a fresh import.
9. No capability manifest row was added (no new tool).

### Measured / unverified

- Not measured: PDF text extraction memory for a PDF near 1 MiB (the test only checks that a 700 KiB response is fetched and returned; extraction fails on the zero-filled body and returns empty text). Plan says to measure during the staging soak.
- Not verified live: real pages through Readability, the cache folder permissions in the container, and the stale hint in a real agent run.
- `browse_url` prompt cost went up slightly (one more parameter and a longer description). The combined measure for all new schemas is left for WP7.
- Not done here on purpose: docs, audit rows, CHANGELOG, platform docs index, skill instruction lines mentioning `web-cache/` (WP7).
