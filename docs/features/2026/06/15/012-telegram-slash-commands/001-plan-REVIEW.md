# Review: Telegram Slash Commands

## Verdict

Partially implemented.

The branch adds reserved-name validation in [apps/api/src/routes/agents.ts](../../../../apps/api/src/routes/agents.ts), introduces a dedicated parser in [apps/api/src/routes/telegram-command-parser.ts](../../../../apps/api/src/routes/telegram-command-parser.ts), and wires slash-command and default-routing behavior into [apps/api/src/routes/agent-interactivity.ts](../../../../apps/api/src/routes/agent-interactivity.ts). But the parser currently depends on name resolution in a way that breaks one of the core command semantics.

## Findings

1. High: bare unknown target names are not parsed as targets.
   [apps/api/src/routes/telegram-command-parser.ts](../../../../apps/api/src/routes/telegram-command-parser.ts) only treats a bare token as a target when it already appears in `knownAgentNames`. That means `/to UnknownAgent buy BTC` is parsed as a plain message body instead of `{ targets: ['UnknownAgent'], body: 'buy BTC' }`, so the webhook falls through to default routing instead of replying `No agent named UnknownAgent found.`

2. Medium: parsing is coupled to current user agent state instead of being a pure syntax pass.
   The plan called for a pure parser that returns targets and body, with agent lookup happening later. Encoding known-name resolution into parsing makes command behavior vary by caller state and complicates testing and maintenance.

## Suggested Change List

1. High: modify [apps/api/src/routes/telegram-command-parser.ts](../../../../apps/api/src/routes/telegram-command-parser.ts) so `/to` parsing is syntax-driven and always returns bare leading target tokens, even when the names are unknown.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: preserve quoted names, `all`, `*`, and multi-target parsing while removing the dependency on the known-agent-name list.
   Test expectation: unit-test `/to UnknownAgent buy BTC` and other unknown-name variants.

2. Medium: update [apps/api/src/routes/agent-interactivity.ts](../../../../apps/api/src/routes/agent-interactivity.ts) so lookup and user-facing `not found` responses happen after parsing, not during parsing.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: keep broadcast, duplicate-name fanout, and single-running-agent default routing behavior unchanged.
   Test expectation: integration-test webhook routing for unknown, duplicate, and broadcast targets; no visual verification needed.