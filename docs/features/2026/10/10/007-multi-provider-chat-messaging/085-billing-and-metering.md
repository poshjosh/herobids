# Billing and metering for paid chat messages

**Status:** planned (decided default 2026-10-23; not started)
**Parent:** [000-README](./000-README.md) · **Plan:** [900-implementation-plan](./900-implementation-plan.md), Phase 4 (WhatsApp)

## Why

Meta charges for some WhatsApp service messages from 1 October 2026. Secondary
sources say the first 1,000 service messages per business number per month are
free, and each one after that is billed. Meta's own rate card must be confirmed
before launch. The same metering may later apply to other paid channels.

## Decisions

- **Default model: `pass_through`** (owner, 2026-10-23). Users pay what Meta
  bills for their messages.
- **Switchable.** The model is config, not code. Switching models changes only
  the rule applied to the usage ledger. Stored data does not change.
- **Users see their usage count** whichever model is active.

## Config (`messaging.chat.billing`)

Operator config (`config/default.yaml` and the schema). Each env override has a
committed `.example` twin.

| Key | Meaning |
| --- | --- |
| `model` | `pass_through` (default) \| `markup` \| `included_allowance` \| `threshold` |
| `pass_through.source` | `meta_billable_flag` (default, assumed) \| `local_count` |
| `freeMonthlyMessages` | Used only by `local_count`. Default 1000 |
| `markupPct`, `includedMonthly`, `thresholdMonthly` | Parameters for the other models. No hard-coded values |

- **`meta_billable_flag`.** Bill a message when Meta's status webhook marks it
  `pricing.billable`. Meta's docs do not say whether this flag already reflects
  the October 2026 free allowance, so it must be checked against invoices.
- **`local_count`.** Bill messages above `freeMonthlyMessages` per business
  number per month, counted in time order. This needs a per-number, per-month
  sequence number in the ledger. It is only used if the flag proves unreliable.

Rate source: Meta's per-country rates, stored as config.

## Usage ledger

Every outbound paid message is recorded: user, agent, timestamp, window type,
`billable` flag, and the Meta message ID. Record only messages Meta accepted.
Failed sends are never billed.

## Gate

- Ledger records each accepted outbound send, and no failed sends.
- Each `model` and `source` option is covered by unit tests.
- Switching `model` changes billing output without changing ledger rows.
- Before go-live: `pass_through.source` is confirmed against a Meta invoice.

## Open items

- Confirm the free allowance and `pricing.billable` behaviour on Meta's rate card.
- Owner to confirm the default model before launch (currently `pass_through`).
