# Decision System

**Status:** Draft v0.2. Created 2026-11-11. The owner accepted `01-strategy.md` as written the same day. Reworked after the first real use (D-2026-001).
**Purpose:** give a human or an LLM agent everything needed to recommend a decision that is consistent with our strategy, our rules, our past decisions and the evidence. Point an agent at this folder, add a problem statement, and get back a reasoned recommendation.
**Not in scope:** implementing the decision. Implementation plans live in `docs/features/`.

---

## Use it in 30 seconds

Copy this prompt, fill the last line, and give it to an agent:

```text
You are the decision agent. Read docs/decisions/README.md and follow its reading order.
Follow docs/decisions/07-agent-contract.md exactly. Do not implement anything.
Problem: <one paragraph, or "docs/decisions/briefs/NNN-<slug>.md">
```

The agent returns a Decision Record (`templates/decision-record.md`). The owner ratifies only what the escalation gate in `06-decision-method.md` says needs ratification.

## Which path does a decision take?

Three paths, plus execution approvals that apply to all of them. Full rules: [06-decision-method.md](./06-decision-method.md) sections 2, 7 and 11.

| Path | When | Who approves |
|---|---|---|
| **1. No framework** | Reversible in under an hour, local, touches no invariant, nobody builds on it (T0). Also: the answer is already fixed by a rule, an Accepted decision or a stated owner requirement. Also: the owner states the decision (record it in `03`, no method) | Nobody |
| **2. Framework, no human approval** | A short note (T1), or a full brief and decision agent (T2) whose gate result is **Settled by precedent** or **Settled within the rules** | The executor proceeds. The owner sees the record afterwards and can veto |
| **3. Framework, then human approval** | A T2 whose gate result is **Needs ratification** (violates a rule, contradicts a decision, undermines an objective) or **Needs owner** (G3: rules cannot decide and it is hard to reverse; G4: a value judgment or a spend beyond an approved plan) | The owner, before anything irreversible or production-affecting |

**Execution approvals are separate.** A settled decision is not permission to act on shared systems. These always need the owner's approval, whatever path the decision took: any change to a shared environment, staging or production (deploy, configuration change, job submit or stop); any Terraform apply or command that can write state; creating or deleting paid servers or other cost-bearing resources; destructive data operations; handling secrets; changing `01-strategy.md` or `02-invariants.md`; and, while it is active, merging to `main` in the trading extraction (INV-P4). Sources: INV-O1, O2, O5, P4, X1.

| Example | Path | Execution approval |
|---|---|---|
| Rename a helper; choose a test layout | 1 | none |
| Raise production `startTimeoutMs` from 60 s to 120 s | 2 (short note, R1) | yes: production deploy |
| Enable capacity-aware start on production (P-03 requires explicit owner approval for the rollout) | 3 | yes |
| Browser front door go or no-go (OD-05) | 2 if no invariant is broken; 3 if INV-X2 is | yes: Terraform apply |
| Stop hard-limited trading agents (OD-12, OD-13): grace period, user message, open positions | 3 (G4, P-08) | yes |
| Hibernation (OD-03) | 3 was required; the owner decided (C-12) | none left |

If unsure which tier applies, the requester proposes one and the decision agent confirms or raises it. When unsure about TR1 to TR3, tier up. The owner can always set the tier.

## Reading order for an agent

| Step | File | Why | Approx. size |
|---|---|---|---|
| 1 | This README | Orientation, precedence, maintenance | short |
| 2 | [01-strategy.md](./01-strategy.md) | What we are trying to achieve, the scale envelope, the trade-off order | short |
| 3 | [02-invariants.md](./02-invariants.md) | Rules that are gates, not preferences | medium |
| 4 | [04-assumptions-and-limitations.md](./04-assumptions-and-limitations.md) | What we believe, how well we know it, what constrains us | medium |
| 5 | [06-decision-method.md](./06-decision-method.md) | How to decide: tiers, evidence, procedure, escalation | medium |
| 6 | [07-agent-contract.md](./07-agent-contract.md) | Your exact instructions and output format | medium |
| 7 | [03-decision-register.md](./03-decision-register.md) | Scan the index. Open only the rows that touch the problem | index |
| 8 | [05-open-decisions.md](./05-open-decisions.md) | See what this problem depends on or blocks | index |
| 9 | The brief or problem statement | The question | varies |

Steps 1 to 6 are the **always-read set** (about 800 lines, roughly 13,000 tokens). Steps 7 and 8 are indexes: scan, then open linked sources only when a row is relevant. Keep the always-read set from growing: move detail into registers and sources.

## Folder map

| Path | Holds | Changes |
|---|---|---|
| `01-strategy.md` | Vision link, strategic and phase objectives, scale envelope, value hierarchy | Rarely. Owner approves |
| `02-invariants.md` | Rule catalogue with IDs, severity, source, how to verify | When a rule is added or retired |
| `03-decision-register.md` | Index of previous decisions: status, what each constrains, where to read it | Every accepted decision |
| `04-assumptions-and-limitations.md` | Assumptions with evidence grades; limits | Whenever evidence changes |
| `05-open-decisions.md` | Backlog of decisions still to make, with dependencies | Often |
| `06-decision-method.md` | The method | Rarely |
| `07-agent-contract.md` | Instructions and output format for decision and challenger agents | Rarely |
| `templates/` | `decision-brief.md` (input), `decision-record.md` (output) | Rarely |
| `briefs/` | One neutral brief per open question | Per decision |
| `records/` | Decision Records returned by agents (create when the first one lands) | Per decision |

## Roles

| Role | Who | Does | Must not |
|---|---|---|---|
| **Requester** | Whoever hits the question (human or implementing agent) | Writes a neutral brief with grounded facts | Rank options or hint at a lean |
| **Decision agent** | A fresh reasoning agent | Recommends, with reasons, confidence and a way to be wrong cheaply | Implement, invent facts, or defer without naming a rule |
| **Challenger** | A second fresh agent (T2 only) | Attacks the recommendation using the same documents | Rewrite the recommendation |
| **Owner** | The project owner | Ratifies when the escalation gate says so. Supplies value judgments and budget | Be asked questions the evidence could answer |
| **Executor** | Implementing agent or human | Carries out the settled decision and updates the registers | Reopen a settled decision without a recorded trigger |

## Document precedence

If documents disagree, the higher one wins and the conflict must be reported, never silently resolved:

1. The owner's explicit, current instruction.
2. `02-invariants.md` and the sources it points to (`AGENTS.md` in each repo, the rollout guide).
3. Accepted decisions in `03-decision-register.md`.
4. `01-strategy.md`.
5. `04-assumptions-and-limitations.md`.
6. A brief or problem statement.

A recommendation that conflicts with 1 to 3 is not forbidden, but it must say so, be marked **needs ratification**, and show the compliant alternative first.

## Plans must carry these decisions

Some owner decisions bind every plan in an area. They are listed in [03-decision-register.md](./03-decision-register.md) under "Decisions every plan must carry". At the time of writing: **C-13** (stop agents over their hard billing limit), **C-12** (agents stay resident, no hibernation) and **SE-1** (no wake latency of tens of seconds). A plan author or a plan-creating agent must read that table and include the decisions that apply.

## Records and ADRs

Both exist, for different jobs. Do not duplicate between them.

| | Decision Record (`records/`) | ADR (`docs/tech/architecture/adrs/`) |
|---|---|---|
| Answers | Why we chose this: options, evidence, review triggers | What is now true about the architecture |
| Scope | Any T2 decision (architecture, operations, billing, process) | Lasting architectural outcomes only |
| Size | About 150 lines plus appendix | One page |

The ADR links to the record and does not repeat its reasoning. The ADR is the authority for its own text and status; the register mirrors it. A record that supersedes an ADR marks that ADR `Superseded` in the same change. Full rules: [06-decision-method.md](./06-decision-method.md) section 13. Worked example: D-2026-001 and ADR-2026-11-019.

## Relationship to what already exists

This folder generalises patterns we already use. Those documents stay authoritative inside their scope.

| Existing | Scope | What this adds |
|---|---|---|
| Traderton `docs/features/initial/008-decision-process.md` and `004-decision-log.md` | Trading extraction | A platform-wide version for greenfield decisions where no source behaviour exists to copy ("parity"). Keeps its escalation bar: violate, contradict or undermine |
| `docs/features/2026/10/10/001-eliminate-parity-check/decision-framework.md` | One epic | Its lightweight/heavy split becomes tiers T0 to T2 |
| `docs/tech/architecture/adrs/` | Architecture decisions | A register with stable IDs, constraints in one line, and review triggers. ADRs stay where they are. The two are linked, not duplicated: the record holds the reasoning, the ADR states the lasting outcome (see "Records and ADRs" below and 06 section 13) |
| `docs/lessons/` | Hard-won lessons | Turned into anti-patterns and invariants |
| `docs/tech/agents/agent-runtime-rollout-guide.md` | Agent runtime changes | Referenced as invariants |

## Maintenance rules

1. **One source of truth.** Registers summarise and link. They do not copy source text. If a summary and its source disagree, the source wins and the summary is fixed in the same change.
2. **Definition of done for a T2 decision** includes updating `03` (new row), `04` (new or changed assumptions), `05` (remove or unblock) and, if a rule changed, `02`.
3. **Every file shows `Last reviewed`.** An agent that finds a stale item flags it in its record; it does not silently rely on it.
4. **Review triggers fire decisions.** Each accepted decision states what would reopen it. The register marks `Review-triggered` when a trigger fires (for example, scale beyond a decision's design envelope).
5. **Evidence beats memory.** Facts enter the registers with an evidence grade and a source. Ungraded facts are treated as guesses.
5a. **Check before you ask or defer.** Agents check the code, the docs and allowed read-only systems before they write "unknown" or ask the owner. Facts only the owner holds are asked once, in a batch with a proposed answer, and recorded the same day. See 06 section 4.1.
6. **Cross-repo.** Traderton keeps its own decision log. This folder links to it by path. Decisions that bind both repos are recorded here and referenced from Traderton.

## Design basis

Not a new invention: ADR practice (record the why), one-way and two-way doors (rigour scales with reversibility), decision-rights roles (RAPID or DACI style), a Pugh matrix against a baseline (avoids false precision from weighted scores), pre-mortem (find failure before it happens), and an explicit assumptions register (the most common cause of bad decisions is an unexamined assumption).
