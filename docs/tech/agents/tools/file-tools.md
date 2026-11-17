# File Tools

Tools that let an agent work with files in its own workspace (`/workspace`), including files up to 16 MiB, without loading them whole into the model context. Code: [filesystem.ts](../../../../apps/worker/src/tools/filesystem.ts) and the modules beside it (`read-file-lines.ts`, `search-files.ts`, `append-file.ts`, `edit-file.ts`, `delete-file.ts`, `web-cache.ts`, `file-messages.ts`, `workspace-quota.ts`). Browse tool: [web-access.ts](../../../../apps/worker/src/tools/web-access.ts). Design and results: [plan](../../../features/2026/11/15/001-agent-file-tools/plan.md), [results](../../../features/2026/11/15/001-agent-file-tools/results.md). Conventions for tool docs: [README](./README.md).

## Visibility

| Tool | Shown when |
|---|---|
| `write_file`, `append_file`, `edit_file`, `read_file`, `read_file_lines`, `search_files`, `list_files`, `delete_file`, `stat_file` | The agent holds the `file-management` or `long-running-task` skill. |
| `read_file`, `read_file_lines`, `search_files`, `list_files`, `stat_file` | Also given to the scout (category `read-filesystem`). |
| `browse_url` | The agent holds the `web-access` skill. |

## Tools

All paths are relative to the workspace root. Counts of characters are Unicode code points, so a page never splits a surrogate pair. File sizes are bytes.

| Tool | Input | What it does |
|---|---|---|
| `read_file` | `path`, optional `offset` (default 0), optional `limit` (default 50,000, max 500,000) | Reads one page of a file by characters. |
| `read_file_lines` | `path`, optional `startLine` (1-based, default 1), optional `limit` (line count), optional `maxChars` (default 50,000, max 500,000) | Reads whole lines. Plain text, no line numbers added. |
| `search_files` | optional `path` (default workspace root), `query`, optional `regex` (default false), `caseInsensitive` (default false), `maxMatches` (default 20, max 200), `contextLines` (default 0, max 3) | Finds text in a file or folder and returns pointers. One match per line (the first on that line). |
| `append_file` | `path`, `content`, optional `ensureNewline` (default true) | Adds text to the end of a file, creating it if needed. Not idempotent: calling twice appends twice. |
| `edit_file` | `path`, `oldText`, `newText`, optional `replaceAll` (default false) | Replaces exact text. Atomic write. Returns a short summary, never the file. |
| `write_file` | `path`, `content` | Creates or overwrites a file. Content is capped (see Limits). |
| `list_files` | optional `path`, optional `offset`, optional `limit` (default 500, max 2,000) | Lists a folder, sorted, with paging. |
| `delete_file` | `path`, optional `recursive` (default false) | Deletes a file. With `recursive: true` it deletes a folder and everything in it, up to `maxDeleteFiles` files per call. |
| `stat_file` | `path` | Reports whether a path exists, its type, size and mtime. |
| `browse_url` | `url`, optional `limit` (inline page size, default 50,000, max 500,000) | Fetches a page. Returns the first page inline. A longer page is saved in full under `web-cache/`. |
| `make_http_request` | `method`, `url`, optional `headers`, `body`, `timeoutMs`, `limit` (inline page size, default 50,000, max 500,000) | Calls an API. Returns the first page of the body inline. A longer body is saved in full under `web-cache/` (JSON is saved indented). |

## Results and paging

Metadata keys come first and the big text key (`content`, `matches`) comes last, so a result cut by stale truncation still shows the path and the next position.

| Tool | Result fields | Paging |
|---|---|---|
| `read_file` | `path, offset, returnedChars, totalChars, totalLines, nextOffset, truncated, hint?, content` | `nextOffset` is the next `offset`, or `null` at the end. `truncated` is true when `nextOffset !== null`. |
| `read_file_lines` | `path, startLine, endLine, totalLines, nextLine, truncated, lineCut?, lineStartOffset?, hint?, content` | `nextLine` is the next `startLine`, or `null`. `truncated` is `nextLine !== null \|\| lineCut`. When one line is longer than `maxChars` it is cut: `lineCut: true`, `nextLine` can be `null`, and the hint points to `read_file` with an `offset` inside that line. Past the last line: empty `content`, `endLine: null`, `nextLine: null`. |
| `search_files` | `path, query, regex, returnedMatches, filesScanned, bytesScanned, skippedBinary, skippedLarge, skippedLongLines, incomplete, incompleteReason?, stoppedAt?, hint?, matches` | Each match has `file`, `line` (1-based) and `offset` (characters, for `read_file`). No paging: narrow `path` or `query`. |
| `list_files` | entries plus `totalEntries, nextOffset, truncated, hint?` | `nextOffset` is the next `offset`. |
| `browse_url` | `url, title, truncated, sourceTruncated, totalChars, returnedChars, nextOffset, savedTo?, saveError?, hint?, content` | See "Web cache". |
| `make_http_request` | `status, statusText, headers, truncated, sourceTruncated, totalChars, returnedChars, nextOffset, savedTo?, saveError?, hint?, body` | Same as `browse_url`, with `body` in place of `content`. See "Web cache". |

`search_files` details:

- A literal query is the default. Case-insensitive literal search uses an escaped pattern with the `i` flag, not lower-casing, because lower-casing can change a string's length and shift the match position.
- A line holds at most one reported match. A second match on the same line is not listed. A minified one-line file therefore gives one match; use `offset` and `read_file` to read around it.
- `incomplete: true` means a limit stopped the search. `incompleteReason` is one of `max_matches`, `result_chars`, `max_files`, `max_bytes`, `deadline`, `max_depth`, `regex_timeout`. Matches found so far are still returned, and the `hint` says what to narrow. `max_matches` is reported only when a match beyond the limit exists.
- Regex uses JavaScript syntax with the `i` flag only. It runs in a worker thread with a hard timeout, so a catastrophic pattern cannot freeze the agent. A pattern that takes too long (or a worker error) ends the search with `regex_timeout`.
- Default searches skip the `platformDirs` at the top level and `dependencyDirs` at any depth. Symlinks are never followed.

`browse_url` fields:

- `truncated`: the inline text is cut (more is in the saved copy, or was not saved).
- `sourceTruncated`: the fetch cap (`browseUrl.maxResponseBytes`) cut the page itself.
- `hint`: present only when the page was saved. It names the exact `read_file` call for the next page.
- `savedTo`: the cached copy, for example `web-cache/example-com-1a2b3c4d5e6f.txt` (host plus a hash of the final URL, so the same URL reuses its file).

## Limits

All values are operator config in `config/default.yaml` under `agentRuntime.tools.files` (and `webAccess`). Defaults live in the Zod schema (`FileToolsConfigSchema`, `WebCacheConfigSchema`). A value above its maximum returns `file.limit_too_large`; nothing is clamped silently.

| Limit | Config key | Default |
|---|---|---|
| Largest file the tools open or grow to | `files.maxFileBytes` | 16,777,216 (16 MiB) |
| Default page (read tools, `browse_url`) | `files.readDefaultChars` | 50,000 |
| Largest page an agent may ask for | `files.readMaxChars` | 500,000 |
| Text per `write_file`, `append_file`, `edit_file` call | `files.writeMaxChars` | 16,000 |
| Files counted when measuring the workspace | `files.quotaWalkMaxFiles` | 2,000 |
| Files removed per recursive delete | `files.maxDeleteFiles` | 5,000 |
| Folders skipped by the quota walk and default searches | `files.platformDirs`, `files.dependencyDirs` | `sandbox, .agents, .claude, agent`; `node_modules, .git` |
| `list_files` entries | `files.list.defaultEntries`, `files.list.maxEntries` | 500, 2,000 |
| Search matches | `files.search.defaultMatches`, `maxMatches` | 20, 200 |
| Search result text at the default match count | `files.search.defaultResultChars` | 8,000 |
| Context lines around a match | `files.search.contextMaxLines` | 3 |
| Search files, bytes, time, depth | `files.search.maxFiles`, `maxScanMb`, `deadlineMs`, `maxDepth` | 500, 50 MiB, 3,000 ms, 8 |
| Query and regex length, regex line length | `files.search.maxQueryChars`, `maxRegexChars`, `regexLineMaxChars` | 200, 100, 2,000 |
| Fetch cap for `browse_url` and `read_document` (shared) | `webAccess.browseUrl.maxResponseBytes` | 2,097,152 (2 MiB) |
| Body cap for `make_http_request` | `httpClient.maxResponseBytes` | 10,485,760 (10 MiB) |
| Web cache size (shared by `browse_url` and `make_http_request`) | `webAccess.webCache.sizeMb`, `dir` | 200 MiB, `web-cache` |
| Workspace quota per tier | `sandboxDefaults.workspaceDiskMb`, `resourceProfiles.<tier>.workspaceDiskMb` | 100 (free, starter), 500 (pro) MiB |

The `browse_url` default capability grant no longer sets `maxResponseBytes`, so the config value governs. A per-agent `tool_policy` still wins.

`maxToolResultChars` (runtime policy) is not a read cap. It only limits the copy of each tool result stored in history for the next tick. It does not limit what the model sees in the current run.

Settings are passed to the container at start. After a change, restart the agents.

## Errors

Every error says what happened with the numbers and gives the next call, written as a tool signature (see [README](./README.md)). Messages are built in `file-messages.ts` from one signature map, and a drift test fails if a message names an unknown tool or parameter.

| Code | When | Next step in the message |
|---|---|---|
| `file.path_invalid` | Absolute path, `..`, or a path that leaves the workspace | Use a relative path; check folders with `list_files` |
| `file.reserved_path` | `sandbox` (writes), or the workspace root or a platform folder (delete) | Write to another folder |
| `file.not_found` | The path does not exist | For `web-cache/`: cached pages are cleared on restart, call `browse_url` again |
| `file.is_directory` | A file tool was given a folder | For `delete_file`: use `recursive: true` |
| `file.not_a_directory` | `list_files` on a file | Read it with `read_file` |
| `file.not_a_file` | A FIFO, device or other non-regular file | Choose another path |
| `file.not_text` | `edit_file` on a file that is not valid UTF-8 | Replace it whole with `write_file`, or use another file |
| `file.too_large` | A file over `maxFileBytes` (open) | `read_file_lines`, or `search_files` |
| `file.write_too_large` | A write that would pass `maxFileBytes` | Continue in a new file |
| `file.content_too_long` | Content over `writeMaxChars` | Split it and call `append_file` per part |
| `file.limit_too_large` | A `limit`, `maxChars`, `maxMatches` or similar over its maximum | Use a smaller value or narrow the search |
| `file.quota_exceeded` | The workspace is over its quota, or has more than `quotaWalkMaxFiles` files | Free space with `delete_file`; names the largest folders |
| `file.delete_too_many` | A recursive delete over `maxDeleteFiles` | Delete subfolders one at a time |
| `file.permission_denied` | EACCES or EPERM | Choose another path |
| `file.io_error` | EIO or ENOSPC (platform fault, `errorOwner: platform`) | Do not retry; tell the user |
| `edit.text_not_found`, `edit.ambiguous_match`, `edit.no_change` | `oldText` missing, matching more than once, or equal to `newText` | Not found or ambiguous: see the message (read the area with `read_file_lines`, add context or set `replaceAll`). No change: pass different text |
| `search.invalid_pattern` | The regex does not compile, or is too long | Fix it, or set `regex: false` |

Content-level errors use `fault: false`, so they never trip the tool circuit breaker. Success results carry a `hint` only when there is a next step (more pages, an incomplete search, a saved page). A plain success has none.

## Workspace quota

A soft, application-level quota per tier, set by `workspaceDiskMb`. The launcher resolves it (profile, then default) and gives it to the container as `AGENT_WORKSPACE_QUOTA_MB`. A write that would grow the workspace past the quota is refused with `file.quota_exceeded`. Shrinking or same-size edits still work when the workspace is full.

The walk counts regular files, including `web-cache/`. It skips `platformDirs` at the top level and `dependencyDirs` at any depth, because `execute_code` rebuilds `sandbox/` and installs dependencies there.

## Web cache

`browse_url` and `make_http_request` return the first page inline. When the page or body is longer, the full text is saved to `web-cache/<host>-<hash>.txt`, a plain folder in the workspace. For `make_http_request` the hash also covers the method and request body of a non-GET call, so two POSTs to one URL get different files, and a JSON body is saved indented so `read_file_lines` and `search_files` work on it. Nothing is deleted automatically, by any tool. The agent frees space with `delete_file`.

Save order: `webCache.sizeMb: 0` skips saving; then the cache cap; then the workspace quota; then an atomic write. If the cap or quota is full, nothing is saved or deleted. The call still succeeds with the first page and a `saveError` that tells the agent to free space and call again. There is no in-memory fallback. When saving is skipped or fails, `nextOffset` is `null`, since it is an offset into the saved file. Other save failures (for example permissions) are logged and returned as `saveError` too.

The cache is part of the ephemeral workspace: cached pages are lost when the runtime restarts.

The workspace quota still applies on top of `webCache.sizeMb`: with the free and starter quota of 100 MiB, the cache cannot grow past what the quota leaves free, whatever `sizeMb` says.

`read_document` shares the fetch cap. A PDF up to 2 MiB is now fetched. Memory used to extract text near that size is untested; check it in the staging soak.

## Security notes

- Every path goes through `resolveWorkspacePath` (no absolute paths, no `..`, no `realpath` outside the root). Write tools also refuse the reserved `sandbox/` folder. Reads of `sandbox/` are allowed.
- Reads open only regular files, so a FIFO planted by sandboxed code cannot block a read.
- `edit_file` writes through a temp file in the same folder and `rename`, copying mode and owner when possible. On a symlink inside the workspace it edits the target and the link stays a link.
- `delete_file` refuses the workspace root and the exact top-level platform folders. A symlink is unlinked, never followed.
- Page text from `browse_url` is untrusted content, not instructions. The tool description says so.
- The regex engine is JavaScript's. A pattern runs in a worker thread that is terminated on timeout.

## Known gaps

- The quota is soft. It is checked inside the container and does not stop a process that writes directly, such as `execute_code`. There is no hard disk limit for `/workspace`.
- The web cache cap and the quota check are not atomic across concurrent calls, so two parallel saves can overshoot slightly.
- `append_file` is not idempotent. A retry after a lost result appends twice. Use `edit_file` or `write_file` when the result must be repeatable.
- The workspace is ephemeral: files do not survive a runtime restart.
- Symlink swaps between the path check and the open are an existing race, unchanged here.
- A crash can leave `.write-*.tmp` files, which count toward the quota until deleted.
- `write_file` and `append_file` are not atomic (only `edit_file` is).
- Tool results older than `toolResultFullRetentionTurns` are still cut. The marker says how much was kept and, for the read, search and browse tools, how to read it again.

## Not in this version

- `download_file`.
- A hard disk limit for `/workspace` (needs an infrastructure change).
- Pinning file reads against stale truncation.

## Audit

Argument sources are tracked in the [tools audit](./audits/2026/06/001-tools-audit.md).
