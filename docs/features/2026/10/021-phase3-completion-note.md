# Phase 3 — Completion note (Steps 11–13)

**Date:** 2026-10-03. **Author:** autonomous implementing run.
**Package:** [`010-phase3-program/`](./010-phase3-program/ENTRYPOINT.md).
**Branches (zero pushes, D20):** herobids `phase3-external-backend` · traderton
`phase3-mcp-surface` · traderton-skills `phase3-skill-publication`.

## The mandated status sentence (ENTRYPOINT §8 G9 — verbatim)

> "Phase 3 Steps 11–13 are locally verified. The write path has NOT been proven
> against the live Traderton boundary. No differential against the pinned oracle,
> no load evidence, and no staging confirmation were produced. This run does not
> establish cutover readiness."

## What was delivered

herobids now reaches External Backend tools only through a generic, trust-gated,
**transport-pluggable** path. Both transports are implemented and proven:

- **Step 11 (generic client migration + transport seam).** The `traderton/`
  client module is renamed to `external-backend` with an internal transport seam;
  `RestTransport` is the default; `appConfig.externalBackends[]` is the operator
  registry. No behaviour change (parity verified).
- **Step 11b (`McpTransport` + the backend MCP surface).** MCP spike gate 1
  PASSED (SDK frames authenticate under the unmodified signer). Traderton hosts an
  MCP route over its existing dispatcher, **off by default**, authoring zero
  execution semantics (one core, two seams). herobids `McpTransport` sits behind
  the seam. Contract suites run over `['rest','mcp']`; a cross-stack parity leg
  executed against the real local MCP route (4 MCP legs) and runs inside the
  mandated herobids `--e2e` suite.
- **Step 12 (trust-gated deep integration).** A descriptor verification pipeline
  (ed25519/JCS, pinning, expiry, backendId, revocation → instruction-only on
  failure) is the sole authority for tool schemas (D16/DT4). The hard-coded
  trading branches are replaced by a generic rule — a skill ref matching an
  enabled definition + a verified descriptor exposes the descriptor's tools, else
  instruction-only. No backend-identity branch in the visibility path (I1 intent
  met).
- **Step 13 (Traderton skill publication).** Three `SKILL.md`
  (`crypto-trading`, `crypto-bot-management`, `crypto-risk-monitoring`) are
  authored in `traderton-skills`. A dev-signed descriptor (private key gitignored,
  public key in config) replaced and DELETED the Step-12 stub (I10 grep = 0). The
  full publication chain — install → descriptor resolution → tool visibility →
  invocation → result mapping — is verified end to end on the local fixture
  source over BOTH transports.

The strategic test holds: a second, unrelated backend can be exposed for tool
**visibility** with config + a signed descriptor and zero platform code change
(proven by a non-trading `example-echo` genericity test). The single remaining
code-change — for a second backend's tool **invocation** over HMAC — is the 1→N
`EXTERNAL_BACKEND_CONFIG_JSON` forwarding, carried to Step 16 (CF-13).

## Definition of Done

All nine gates pass (DECISIONS §5 G0–G9 record). G2: the five mandated suites all
exit 0 at their default gates. "Done" means LOCALLY VERIFIED — see the G9 sentence
above; it does not mean cutover-ready.

## Carried-forward obligations (G9 — blocking, all recorded)

**Read these for what is already satisfied, not only what is owed.** Several are
only *partially* open; the behavioural/resilience evidence lives in the Phase-1
readiness runbook (`../../../../infra/hetzner/docs/runbooks/phase1-operational-readiness.md`),
not in the carried-forward list — a reader judging "production readiness" from the
obligations alone will overstate what remains.

Still fully open: CF-3 REST differential vs the pinned pre-removal oracle (the
core extraction-safety gate) · CF-8 push gate (all three repos) · CF-9 real
operator-held signing key · CF-10 conditional MCP differential leg · CF-11 open
legal/product dispositions · CF-13 1→N forwarding · CF-14 real-remote `npx skills`
resolution.

Partially satisfied / not a blocker: **CF-6** — restart/health/fail-closed/
recovery/idempotent-retry/HMAC proven **live, operator-approved, 2026-10-01**
(runbook §C); only the write-path durable-dedup proof against live staging
remains. **CF-7** — rollback is a recorded operator decision (teardown+rebuild
accepted pre-launch), not a gap (runbook §E). **CF-4/CF-5** — N/A until a metrics
system exists (runbook §D); deferred, not failed. **CF-12** — pre-existing
baseline skips.

Each has an evidence path in `010-phase3-program/DECISIONS.md §5` and a home in
the program `PROGRESS.md` + the Step-16 obligation list.

## The single operator batch

`010-phase3-program/ESCALATIONS.md`: **E1** only — the mandated herobids
`run-extra-tests.sh --all` Tier 6 contacts herobids staging (read-only) and sends
a Telegram message. It was run green at the closeout G2 per P3-1; the operator
owns the standing policy on whether that contact belongs in the Phase-3 gate.
N1–N5 are pre-seeded carried questions, none blocking.

## Next

Steps 14–16 remain (D12): remove herobids first-party trading ownership (Step
14), trading-domain cleanup (Step 15), and the final staging proof (Step 16) that
discharges the carried obligations above. The three branches await the operator's
push/merge decision (CF-8).
