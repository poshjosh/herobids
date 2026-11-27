# Browser Form Actions and Herobids-Agnostic External Skills

**Status:** Draft
**Estimated effort:** ~4 days (refine after Phase 0)
**Dependencies:** None blocking. Phase 5 depends on Phases 3 and 4.

## Summary

On 27 Nov 2026 an agent applying for a GitLab job (Greenhouse form) stopped with
"BLOCKED". It could fill text fields but could not attach the CV or set dropdowns.
`browse_interactive` has seven actions (`open`, `snapshot`, `click`, `fill`,
`screenshot`, `get_text`, `close`) and none can upload a file, choose a dropdown
option, tick a box or press a key.

This plan covers two workstreams:

- **Part A:** add upload, select, check, press and type actions to
  `browse_interactive`, each returning a read-back of the page state. Verify in
  the local docker stack.
- **Part B:** make external skills herobids-agnostic. They describe capabilities
  in plain terms (for example "make an HTTP GET request"), never herobids skills,
  tools or platform names. A check enforces this.

## Decisions

| Topic | Decision |
|---|---|
| Upload file scope | Any file in the agent's workspace, or any file the user has sent to the agent. Nothing else. |
| Verification environment | Local docker stack. The staging browser pool is not used for this work. |
| External skill naming | Capability names only. No herobids names, tool names, or `system/...` skill ids. |

Consequence of the upload scope: any readable workspace file can reach any site
the agent visits. A2 lists the mitigations.

## Goals

- Agents can attach files to form fields, set native and custom dropdowns, tick
  checkboxes and press keys, without a shell.
- Every change an agent makes is confirmed by reading the page state back, so an
  agent never reports a value as set when the page ignored it.
- External skills work for agents outside herobids: no platform-specific names,
  and they say what to do when a capability is missing.

## Non-Goals

- Running the `agent-browser` CLI route (needs `execute_shell` and sandbox access
  to the pool, which is unverified).
- Replacing or renaming `browse_interactive`.
- Submitting any real job application. Automated verification stops before submit.
- Changing the Browserless pool configuration.

---

## Part A: Browser Form Actions

### A1. Action contract

Status: DONE (select, check, uncheck, press, type; review rounds 1–3 resolved; see Outstanding Issues)

| Action | Input | Behaviour | Returned read-back |
|---|---|---|---|
| `upload` | `selector`, `file` (workspace path or attachment reference) | Worker reads and validates the file (A2), then the page attaches it to the file input and dispatches `input` and `change` | File name, size, and the input's `files` count |
| `select` | `selector`, `option` (label or value) | Native `<select>`: set value, dispatch `change`. ARIA combobox: focus, type with `Input.insertText`, choose the matching option; no Enter fallback; if no option matches, return an error listing the available option labels | Selected label shown in the control. The read-back uses only the combobox's own container (at most 4 ancestors, stopping at any container that holds a second combobox) and its `aria-controls` listbox; it never reads the whole document |
| `check` / `uncheck` | `selector` | Click only when the current state differs | Checked state |
| `press` | `key` (for example `Tab`, `Enter`) | `Input.dispatchKeyEvent` | None |
| `type` | `text`, optional `selector` | `Input.insertText` into the focused or given element, so real input events fire. Fields that reformat input (phone masks) may report an error even when the text was entered; the error shows the observed value and asks the agent to check before retrying | Element value |

Rules that apply to every mutating action:

- The read-back comes from the DOM after the action, not from the action's own
  success. A mismatch between the requested and read-back value is an error with
  the observed value in the message.
- `fill` stays as it is for plain text fields. Its behaviour is unchanged.

Snapshot changes:

- The 200-node cap becomes configurable. When the output is truncated, the output
  says so, so the agent knows fields may be missing.

Timeouts:

- The 10 s per-command timeout stays as the default. `upload` and `select` get a
  longer budget (proposed 30 s).

### A2. Upload file access

Status: DONE (review rounds 1–3 resolved; see Outstanding Issues)

- **Roots:** the agent's workspace root only (`/workspace`). User-sent files are
  copied under `/workspace/docs/`, so they are covered. Anything else is rejected.
- **Path checks:** resolve with `realpath` before checking the root. Reject `..`
  escapes and symlinks that resolve outside a root. Reject directories.
- **Size limit:** 10 MiB (10,485,760 bytes), a named constant.
- **Transfer:** the worker reads the bytes and sends them to the page in chunks,
  to stay under CDP message limits (to be measured).
- **Injection:** the page builds a `File`, puts it into a `DataTransfer`, assigns
  `input.files`, and dispatches `input` and `change` with `bubbles: true`. If the
  input is hidden behind a styled button, the action targets the input directly
  and does not click the button.
- **Audit:** each upload is logged with agent id, session id, source path, size,
  SHA-256 and the page URL. File content is not logged.
- **Implementation note:** cap is 10 MiB (10,485,760 bytes; named constant, not the
  16 MiB read-tool `maxFileBytes`). The file is opened once by its resolved real path
  (`O_NOFOLLOW | O_NONBLOCK`), checked by handle stat and inode identity, and read
  through the handle with a bounded read, so growth after the size check is rejected.
  `O_NONBLOCK` stops an `open` on a FIFO from blocking; the handle stat then rejects
  the non-regular file. Hard links are rejected: after fstat, `nlink > 1` is a
  non-fault error, so a second name for a workspace file cannot be used to read it
  through a different path. After open, on Linux, `readlink(/proc/self/fd/N)` must
  name the real file or a path under the real root; otherwise the upload is rejected
  as an escape. Where `/proc` is missing (macOS, ENOENT), the check is skipped with one
  warning per upload and only the dev/ino check applies. This is a residual limitation
  on macOS: a parent directory swapped between realpath and open is not detected there.
  Base64 chunks are 512 KB per evaluate call, staged on a per-upload `window` key that
  is cleared on success and on failure. The whole upload has a 60 s deadline. Each chunk
  and the attach evaluate use `min(timeout, remaining)` as their timeout, and the
  deadline is checked before each one, so no single call can outlive the deadline.

Rejected alternative: CDP `DOM.setFileInputFiles` with a host path. The pool runs
on a different host from the agent, so the file would have to exist there too.

### A3. Permissions

Status: PENDING

`browse_interactive` keeps its default grant. Uploads read workspace files and
send them to third-party sites, so whether `upload` needs a higher permission
level is an open question (see Open Questions).

### A4. Skill text (internal)

Status: PENDING

Update `BROWSER_SKILL` in [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts)
to list the new actions with one example each. This is a herobids system skill,
so herobids tool names are allowed there. Part B does not apply to it.

Update [browser-pool.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/architecture/browser-pool.md)
with the new actions and the verification result.

### A5. Unit tests

Status: PENDING

Focused cases only, in [browser.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/browser.test.ts):

- `upload` rejects a path outside both roots, a `..` escape, and a symlink that
  resolves outside.
- `upload` rejects a file over the size limit.
- `upload` accepts a workspace file and a user-sent file.
- `select` returns an error when the read-back does not match the requested option.
- `check` does not click when the state already matches.

### A6. Verification in the local docker stack

Status: PENDING

Prerequisite: `docker-compose.dev.yaml` runs a `browser-pool` service
(`ghcr.io/browserless/chromium`, host port 3001). `config/default.yaml` points the
worker at `http://browser-pool:3000`. That is confirmed in config; a live end-to-end
run is still unverified.

Fixture page, served by the local stack, containing:

- Text fields with validation on blur.
- A native `<select>` (Country).
- A React custom combobox (Employment restrictions, Yes/No).
- A radio or checkbox group (Visa sponsorship).
- A file input hidden behind a styled button.
- A submit button whose handler only records the form data.

Scenario, run through an agent rather than by hand:

1. Upload a CV from the workspace.
2. Upload a file the user sent to the agent.
3. Select a native option.
4. Select a combobox option.
5. Check and uncheck a box.
6. Press `Tab` to trigger blur validation.
7. Take a final snapshot and read back every field.

Pass criteria:

- Every read-back equals the expected value.
- The fixture records the uploaded file name, and the hash of the received bytes
  matches the source file.
- An out-of-scope path is rejected with a clear error.
- The fixture's submit handler is never called.

Real sites (for example the GitLab Greenhouse form) are not part of automated
verification. Any live check needs the user's approval, uses test data, and stops
before submission.

Repo checks: the build, lint and unit test sequence from the `test-and-fix` skill,
plus the new unit tests.

---

## Part B: Herobids-Agnostic External Skills

### B1. What counts as an external skill

Any skill published in `openaidom-skills` or `traderton-skills`, and any skill
meant to run outside herobids. Rules:

1. No herobids name in skill files (the word "herobids", internal paths, or
   `system/...` skill ids).
2. No herobids tool names. The banned set is every name in the tool catalog in
   [tools.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/tools.ts),
   for example `browse_interactive`, `send_message`, `publish_artifact`,
   `make_http_request`, `execute_shell`, `finish_run`.
3. Describe capabilities in plain verbs: "make an HTTP GET request", "upload a
   file to a form field", "message the user", "deliver a report".
4. Say what to do when a capability is missing, for example "If you cannot upload
   files, stop and report the blocker. Do not submit."

A short capability vocabulary (web search, read page, HTTP request, read document,
file read/write, run code, browser open/read/click/fill/select/upload/check/press,
message the user, deliver an artifact, schedule, memory) goes in a reference file
in `openaidom-skills`, so skill authors use the same words. The list is proposed
and needs review.

### B2. Current audit

The audit searched both repos for common herobids tool names and the word
"herobids". It did not run the full tool-catalog check (that is B3).

| File | Lines | Finding | Proposed change |
|---|---|---|---|
| `traderton-skills/skills/crypto-bot-management/SKILL.md` | 23 | Names `send_message` | "message the user" |
| `traderton-skills/skills/crypto-risk-monitoring/SKILL.md` | 17–18 | Names `send_message` and `publish_artifact` | "message the user"; "deliver the output as a report" |
| `traderton-skills/README.md` | 3–8 | Names herobids and its internal step and decision ids | Reword to describe the skills without herobids specifics. Move the herobids-specific resolution notes to herobids docs. |
| `traderton-skills/CHANGELOG.md` | 12 | Mentions "former herobids ICT swing playbooks" | Reword (decided, see Decisions Recorded) |
| `openaidom-skills/skills/job-search/SKILL.md` | 15, 21, 136, 140 | "the platform's run status" and an `.agents/skills/...` path convention | Review. Both assume a runtime layout. Reword to "the run's status or a clock" and "the skill's references folder". |
| `openaidom-skills/skills/job-application/SKILL.md` | 127 | Already capability-based ("browser, web and document capabilities") | Add the browser capability guidance from Part A (upload, select, check) with the stop-and-report rule |

### B3. Enforcement

- A check runs in herobids CI against checkouts of `openaidom-skills` and
  `traderton-skills`. It fails on any banned term from B1.
- The banned list is derived from the tool catalog, so it stays in step with the
  tools. The external repos do not need to know about herobids.
- The check is a plain text search over skill files and READMEs. Code blocks are
  included.

### B4. Acceptance

- The check passes on both repos.
- A reviewer who has never seen herobids can read `job-application` and map each
  capability it names to a tool they have, or see that it must stop and report.

---

## Phases

| Phase | Work | Depends on |
|---|---|---|
| 0 | Confirm open questions below | — |
| 1 | External skill fixes (B2) and capability vocabulary (B1) | 0 |
| 2 | Action contract and upload policy (A1, A2); write the unit tests first (A5) | 0 |
| 3 | Implement the actions (A1, A2) and update `BROWSER_SKILL` and browser-pool docs (A4) | 2 |
| 4 | Verify in the local docker stack (A6) | 3 |
| 5 | Update `job-application` with capability wording (B2) and add the banned-term check (B3) | 1, 4 |

Phase 1 is independent of Part A and can ship first.

## Decisions Recorded (answers from review)

1. **Upload size limit:** 10 MiB (10,485,760 bytes).
2. **Permission for `upload`:** same default grant as `browse_interactive`.
3. **Who gets `upload`:** all browser-enabled agents.
4. **traderton CHANGELOG:** reword the herobids mention.
5. **Upload roots (resolved in code):** user-sent files are copied into the agent
   container at `/workspace/docs/original/<docId>-<name>` (and `extracted/`) by the
   runtime materializer, for staged documents only, on session start or refresh.
   So the single upload root is the workspace root (`/workspace`). No new port is
   added to `ToolContext`. Gap accepted: a document from an earlier session that is
   not re-staged may be absent from a new container.

## Open Questions

None open for Part A.

## Consequences of the decisions

- With the default grant and all browser-enabled agents covered, the upload
  exposure risk in the Risks section is accepted. The audit log (A2) and the
  root restriction remain required.

## Risks

- **Upload injection may not trigger some frameworks' handlers.** Mitigation: test
  on the React fixture, then on one real form with the user's approval before
  relying on it.
- **Combobox behaviour varies by site.** Read-back catches failures but does not
  fix them. Expect some sites to need site-specific handling later.
- **Local stack may lack Browserless.** If so, Phase 4 needs a compose change.
  That is a separate decision.
- **Data exposure.** Any workspace file can be uploaded to any site. Mitigations:
  the audit log (A2), the skill rule to upload only documents the user approved,
  and Open Question 3.
- **Timeouts on large files.** Base64 transfer of a 10 MB file may exceed the
  default budget. Measure in Phase 4.

## Outstanding Issues

Recorded by the coordinator after the A1 review (MEDIUM and LOW only).

### A1. Action contract

- No wall-clock deadline in the combobox option poll. After the Node-side timeout the page loop can keep running and click an option after the tool has reported failure. Fix with a `Date.now()` deadline inside the page script, set below the Node timeout.
- Caret-less identical replacement (contenteditable, email, number) still reports an error when the same text replaces the same text.
- Check and uncheck read back once. Asynchronous widgets can report a false failure; consider a short poll.
- Native `<select>` compares against the requested string, not the matched option's value.
- `text` in `type` is unbounded and may be empty. Add a minimum of 1 and a maximum length.
- Page exception details are swallowed in `evaluateInPage`.
- Multi-step select has no overall deadline (up to about 150 s).
- Uncheck on a checked radio button fails.
- `resolveKey` virtual key codes are wrong for punctuation keys.
- `type` echoes password field values in the error or data. Redact for `type="password"`.
- `openForm` in the tests sleeps 500 ms per test.
- No per-session queue for multi-step CDP actions.
- `aria-controls` with several IDs returns "does not resolve". Take the first ID that resolves.
- Test gap (H-2, deferred to A6): no test runs the page-side JavaScript. The worker has no DOM test environment. A6 covers it with a real browser.
- Real-browser behaviour of react-select-style comboboxes and masked inputs is unverified until A6.

### A2. Upload file access

- Error mapping: ENOENT and ELOOP from `open`, `realpath` or `stat` fall into the catch-all and are not mapped to the specific messages.
- The containment check is duplicated between the `realpath` check and the post-open `/proc` check. Consolidate into one helper.
- `pageUrl` is logged with userinfo and path tokens. Strip them before logging.
- `workspace.ts:52` uses `normalized.startsWith('..')`, which also rejects a legal name such as `..notes.txt`. Check path segments instead.
- Root-path message: the message for a path that is the root itself needs review.
- Windows `O_NOFOLLOW` note: the flag has no effect on Windows, so the symlink guard relies on realpath there. Document this.
- `mockLogger`, and the queued `mockResolvedValueOnce`/`mockImplementationOnce` values on `open` and `readlink`, are not reset between tests. A test that fails before it consumes its queued value can leak into the next one.
- Fixed in round 3: the prepare call is bounded by the remaining 60 s deadline, and the post-open `/proc` check now requires the opened path to equal the checked real path (Linux). Covered by a new in-root sibling test.
- Residual limitation (macOS): no `/proc`, so a parent directory swapped between realpath and open is not detected. The dev/ino check cannot see it either. A6 should exercise the macOS path.
