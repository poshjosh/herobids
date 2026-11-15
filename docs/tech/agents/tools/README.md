# Tool Documentation Conventions

How tools are documented under `docs/tech/agents/tools/`. Follow this when you add or change a tool.

## Page layout

One page per tool family, in the style of [agent-creation-tools.md](./agent-creation-tools.md) and [file-tools.md](./file-tools.md):

1. Source links (the tool modules) and a link to the plan or design.
2. Visibility: when the tool is shown, which skill provides it, whether the scout gets it.
3. A tool table: `Tool | Input | What it does`.
4. Result fields and paging fields, for tools that return pages.
5. A limits table: each limit, its config key and its default. Defaults live in the Zod schema only.
6. An error table: code, when, and the next step the message gives.
7. Security notes, known gaps, and what is not in scope.

## Error codes

Codes are namespaced dot-strings: `file.not_found`, `edit.ambiguous_match`, `venue.timeout`. Add each new code to the error table of its page.

## Message standard

Every error and every limit-hit result says what happened, with the numbers, and the exact next call. The next step is inside the `error` text, because that is what the model reads. Success results carry a hint only when there is a next step (more pages, an incomplete result, a saved copy). A plain success has none.

Build messages in one module per family (for the file tools, `apps/worker/src/tools/file-messages.ts`), not inline in the tool.

## Signature style

Name tools and parameters as signatures: `read_file_lines(path, startLine?, limit?, maxChars?)`. A `?` marks an optional parameter. In text the model reads, use "You can..." phrasing, one line per tool. For the file tools, `toolSignature()`, `toolUse()` and `toolCall()` in `tool-signature.ts` build signatures from one map, and `findSignatureProblems()` is the drift check for skill text and docs. A rename that is not mirrored in the map fails a test.

## Discoverability

No tool may require an argument the agent neither has nor can get. For every argument, the [tools audit](./audits/2026/06/001-tools-audit.md) records where the agent gets it ("Agent Has Info?"). When you add or change a tool, add or update its rows in the same change.

## Checklist for a new tool

- Tool module, registration in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`, and the skills that list it.
- A docs page or a row on the family page, plus audit rows.
- The platform docs index entry in `scripts/ts/build-docs-index.ts`, then `pnpm --filter @herobids/scripts run build-docs-index`.
- A `CHANGELOG.md` line.
