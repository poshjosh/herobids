# Decision Brief B5: Consistency sweep — low-stakes corrections, batchable

- **Question:** A set of small consistency defects surfaced by the audit that don't change architecture — fix them as one batched task, or let each ride a parent decision?
- **Status:** OPEN — pre-loaded for chat. Mostly independent; two items are B1/B3-linked as noted.
- **Evidence:** audit §7 (S5, S7, S8, S9, S12, S14), §4.1, §4.2.

## The batch (each item: defect → proposed correction)

| # | Item | Defect | Correction | Parent |
|---|---|---|---|---|
| 1 | Ungated market-context cards | watch/discovery/regime/pending/queued cards render for any agent receiving such a wake — a non-trading agent's prompt can carry trading context (audit S14) | Gate the five cards on trading capability family (the `requiredFamilies: ['trading']` mechanism already exists for 11 others); wakes are already subscription-filtered upstream, so the gate is belt-and-braces | — |
| 2 | Parallel create/update codepaths | three codepaths stamp the same trading-field semantics: `PATCH /agents/:id` (agents.ts), `PUT /agents/:id` (agent-interactivity.ts), chat `create_agent` (audit S7) | Consolidate to one shared payload-validation/normalization helper (not necessarily one route — API compat); reduces B1 write-through surface from 3× to 1× | **B1-linked**: do it before/with the C1 slice |
| 3 | Admin "Total Bots" ghost | admin UI renders Total Bots + per-user Bots columns; server dropped cross-tenant bot counts deliberately (c4.7) | Remove the stat card + column (or source from a per-owner sum if admin genuinely needs it — recommend removal) | — |
| 4 | Daily-loss framing inconsistency | UI: "Daily loss limit (%) — as a percentage of equity"; public glossary: "Set in USD" (audit S9) | Pick one framing (recommend % of equity, matching the engine's gate) and align glossary + form copy | — |
| 5 | Wallet custody copy | UI asserts "OpenAIdom holds this generated direct-wallet signing key encrypted on your behalf" while minting happens behind the boundary (audit S8) | Align copy with the boundary reality (custody language is legal-adjacent — keep it precise: traderton-side custody per its user_credentials encryption) | — |
| 6 | `GET /agents/:id/trades` dead route | no web consumer (AgentTradesTable uses capabilities/trading positions); parallel surface | Covered by **A5 item 13** — listed here only so the sweep doesn't lose it if A5 strikes it as public-API | A5 |
| 7 | Base-skill tool visibility | broken/irrelevant trading tools on non-trading agents | Covered by **B3(1)** — not duplicated here | B3 |
| 8 | Session-gate hard-coded hours | asia/london/ny session table hard-coded in tick-gates (parity-copied) | If touched at all: config-drive it; otherwise leave (works, parity-pinned) — recommend leave | — |

## Recommendation

Batch items 1, 3, 4, 5 (+ 8 as leave) into a single small Track-A-eligible sweep task ("A9: consistency sweep") once B3's item-7 lands separately; item 2 rides B1's Track C (it's a precondition for clean write-through); item 6 stays in A5.

## Open questions for the chat session

1. Approve the batched A9 sweep (items 1/3/4/5)?
2. Item 2: accept consolidation as a C1 precondition, or promote to Track A (it's mechanical and decision-free)?
3. Item 4: confirm "% of equity" as the canonical daily-loss framing?
4. Item 8: agree "leave as-is"?
