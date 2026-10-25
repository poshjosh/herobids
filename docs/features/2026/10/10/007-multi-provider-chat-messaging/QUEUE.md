# Queue

The only list of what to do next. Work top to bottom. Take the first item whose dependencies are ticked and whose status is `ready`. Tick an item only when its evidence is in [PROGRESS](./PROGRESS.md).

Scope: the messaging MVP and the agent-to-agent MVP (DEC-40 to DEC-46). Deferred items are listed below and are not part of the current scope.

| # | ID | Item | Depends on | Status | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | C0 | Baseline: `pnpm test` counts recorded | none | ready | [C0](./tasks/C0-baseline.md) |
| 2 | C1 | Cutover to `chat_addresses` and `chat_suppressions`; drop the four legacy columns (DEC-01 to DEC-12) | C0 | ready | [C1](./tasks/C1-cutover.md) |
| 3 | CH2W | Two-way agent chat (002): conversation store, write path, owner view (DEC-31, DEC-32) | C1 | ready | [CH2W](./tasks/CH2W-two-way-chat.md) |
| 4 | A2A-A | Same-user check: both agents belong to the same user. No grant table, no screen (DEC-40) | none (may run early) | ready | [A2A-A](./tasks/A2A-A-same-user-check.md) |
| 5 | A2A-B | MVP peer messaging: send path, peer wake, per-user rate limit, owner view, stop switch (DEC-40 to DEC-43) | A2A-A, CH2W | blocked until dependencies are ticked | [A2A-B](./tasks/A2A-B-peer-send.md) |

## Deferred (not in scope; specs kept for later, DEC-45)

| ID | Item | Why deferred | Spec |
| --- | --- | --- | --- |
| C2 | Proof-of-control binding, 409 rule, remove `verify-telegram` | Not needed for agent-to-agent. Known gap: a chat address can be claimed by the wrong user until C2 ships (see [C2](./tasks/C2-binding.md)) | [C2](./tasks/C2-binding.md) |
| C2-R | Independent review of C2 | Depends on C2 | [C2-R](./tasks/C2-review.md) |
| E-R1 | Email fallback sends only when no other channel delivered | Not needed for agent-to-agent | [E-R1](./tasks/E-R1-email-rule.md) |
| U | Messaging as a user capability | Not needed for agent-to-agent | [U](./tasks/U-messaging-capability.md) |
| A2A-C | Safety gate beyond the rate limit: cost cap, turn cap, ping-pong pause, per-pair limit, trade block | Replaced by DEC-42 and DEC-41 for the MVP | [A2A-C](./tasks/A2A-C-safety-gate.md) |
| A2A-D | Prompt-injection stance | Deferred by DEC-44. Owner visibility moved into A2A-B | [A2A-D](./tasks/A2A-D-injection-visibility.md) |
| A2A grants | Grant table and owner screen (from the original A2A-A) | Replaced by the same-user check (DEC-40) | none |

## Already done (do not redo; re-verify only if a later item touches them)

- Schema note for conversation and peer tables, approved (DEC-47): [schema note](../../15/002-two-way-agent-chat/002-schema-note.md).
- P0 baseline, P2.1 to P2.6 (dual-write, removed by C1), P3.1 to P3.4 (route, bypass, config, gate), T (typing indicator, `25f895fe`).
- W (web push) and E (email fallback). Automated gates green. Owner ran the manual checks on 2026-10-24 and reported them passed. M-E5 is open (owner).
- Telegram constant-time secret check (`d553c64e`), bug report [001](../../../../../bug-reports/2026/10/25/001-telegram-webhook-secret-compare-not-constant-time.md).

## Notes on the queue

- A2A-A can run at any time. It has no dependencies.
- CH2W cannot start until C1 is ticked. A2A-B cannot start until CH2W and A2A-A are ticked.
- The chat-binding gap (C2 deferred) is accepted for the MVP. It does not block agent-to-agent messaging.
