# 06 Decision Method

**Status:** Draft v0.2 (reworked 2026-11-11 after the first real use, D-2026-001)
**Last reviewed:** 2026-11-11
**Purpose:** how to decide. Rigour scales with how hard a decision is to undo, so small things stay fast and big things get scrutiny.

## 1. Principles

1. **Decide by default.** Most choices are the executor's. Escalate only for the reasons in section 7.
2. **Do the homework first.** Check the code, the docs and the running system before you list an unknown or ask a question. "Could not determine" is allowed only for things nobody can know yet (section 4.1).
3. **The requester is neutral.** Whoever hits the question describes facts and options without ranking them. A fresh agent decides. This stops the implementer's bias from carrying the call.
4. **Evidence over opinion.** Every number and claim carries a grade ([04](./04-assumptions-and-limitations.md)).
5. **Invariants are gates, not weights.** An option that breaks a HARD invariant is out. It is not outvoted by cost.
6. **Rigour follows reversibility.** One-way doors get the full method. Two-way doors get a short note.
7. **Prefer the cheap experiment.** If a small test would settle the question, recommend the test, with a reversible interim.
8. **Record or it did not happen.** A decision without a record and register update is not finished. Owner answers are recorded the moment they are given.
9. **Right-size.** The framework must not slow routine work. If the method costs more than the decision, drop a tier.

## 2. Tiers

| Tier | Use when | What you do | Record |
|---|---|---|---|
| **T0 Just decide** | Reversible in under an hour (R0), local, touches no invariant, nobody builds on it | Decide and proceed | One line in the commit message: `Decision: ...` |
| **T1 Short note** | Reversible with effort (R1), or sits inside a ratified direction, or others will build on it, or touches a SOFT invariant | Steps 1, 3, 4, 5 (two options minimum) and 8 of section 5, on one page | A note in the relevant plan or PR, and a row in `03` if it will be relied on |
| **T2 Brief and decision agent** | Any trigger below | The full method in section 5 | A Decision Record in `records/`, plus register updates |

### T2 triggers (any one)

| # | Trigger |
|---|---|
| TR1 | It changes compliance with a HARD or FIRM invariant (not merely sits near one) |
| TR2 | It contradicts or supersedes an Accepted decision, or changes a strategic objective |
| TR3 | It is hard to reverse (R2 or R3) |
| TR4 | It adds a shared abstraction, a cross-repo dependency, or a new architectural pattern |
| TR5 | It adds recurring cost above the owner's threshold (until OD-09 sets one: any recurring infrastructure cost not already in an approved plan) |
| TR6 | It depends on a fact only a person or a system we cannot reach can supply |
| TR7 | It affects something with no clear owner, or a consumer we cannot see |
| TR8 | It changes scope: adds or removes a deliverable or objective |
| TR9 | It removes a safety behaviour or an enforcement check, even a duplicated one |
| TR10 | It sets a precedent that is costly to revisit (language, repository layout, vendor) |

Tier up when unsure about TR1 to TR3. Otherwise decide at the lower tier. Over-escalation is also a failure. A decision the owner has already made in plain words is recorded (section 13) without running the full method.

## 3. Reversibility

| Class | Meaning | Examples |
|---|---|---|
| **R0** | Undo in under an hour, no side effects | Rename a variable, change a local script |
| **R1** | Undo within about a week, no data loss, no customer impact | A flagged feature, a staging infrastructure change, a branch |
| **R2** | Undo takes more than a week, or is customer-visible, or costly | A new repository, a language choice for shared code, a node-size standard, a database move |
| **R3** | Cannot be undone | Data deletion, a public commitment, legal exposure, leaked secrets |

**Staged decisions.** When a decision is delivered in stages, state the class of each stage. The decision's tier follows its first R2 or R3 stage, and that stage needs its own record or an explicit owner step before it starts.

## 4. Evidence rules

1. Use the grades in [04](./04-assumptions-and-limitations.md). R2 and R3 decisions cannot rest on grade T, I or G alone.
2. **Cite.** Facts carry a path and line, or the command and its result. "I looked" is not a citation.
3. **Grep is not proof.** A claim that something is unused or absent is proven by a trial change judged by the owning repository's build and full suite, run on a branch or local stack. An agent that cannot make a trial change grades the claim I and names the check that would prove it.
4. **Do not rely on a document you did not open.** Summaries in the register are pointers.
5. **Check the premise.** Ask whether the question assumes something false. Check the status of plan documents against `git log`: a pending plan may already be shipped.
6. **Check before you ask or defer.** If the code, the docs or an allowed read-only command can answer it, you answer it. Never write "could not determine", "unknown" or "not investigated" for something you could have checked (section 4.1).
7. **Numbers are ranges with grades**, not single points. Show the low, expected and high case where the choice is sensitive to them.
8. **Stamp the code state.** A brief or record states the commit it was verified against. Facts that depend on configuration say which environment they apply to (staging and production differ).

### 4.1 Three kinds of unknown

Every gap you find is exactly one of these. Handle it as shown.

| Kind | Examples | Rule |
|---|---|---|
| **A. Checkable** | What the code does; where state lives; which config applies; what a read-only query returns; whether a plan doc is stale | **You must check it.** It never appears as an unknown. It appears as a fact with a source |
| **B. Held by the owner** | Operational numbers the owner has seen, intent, an existing business stance, a latency the product can accept | **Ask once, up front, in a batch** (section 8). Include what you found and a proposed answer so the owner only confirms or corrects. Record the answer immediately |
| **C. Not yet knowable** | A demand curve before launch; behaviour at a scale we cannot reproduce | **It becomes a graded assumption** (G or I) in `04` with the cheapest experiment. It is not a gap to defer |

A gap you cannot classify is kind A until you have tried and can show what you tried.

### 4.2 Evidence access (what an agent may check without asking)

Read-only checks on **staging** are allowed without asking, using the access described in [useful-commands.md](../runbooks/useful-commands.md). Never print secret values.

| System | Allowed | Not allowed |
|---|---|---|
| Repository | Read, search, `git log`, `git show`, `git blame`, read-only analysis | Edits outside `docs/decisions/` |
| Nomad | `status`, `inspect`, `node status`, `service info`, read API calls | `run`, `stop`, `drain`, `eligibility`, `purge` |
| Postgres | `SELECT` queries; `pg_stat_*` views | Anything that writes or locks |
| Redis | `GET`, `HGETALL`, `SCAN`, `INFO`, `CLIENT LIST` | Writes, `FLUSH*`, `DEL`, `CONFIG SET` |
| Docker on staging hosts | `ps`, `inspect`, `logs`, `stats` | `exec` that changes state, `stop`, `rm` |
| Hetzner | `hcloud ... list`, `describe` | create, delete, change |
| Terraform | Reading files and variables | Any command that initialises a backend or can write state (INV-O1, INV-O2) |

**Production** needs the owner's approval for each session. If you have no access at all (sandboxed, no keys), say so, and treat the missing facts as kind B: give the owner the exact read-only commands to run.

## 5. Procedure (T2)

0. **Readiness.** Test the brief against the checklist in the brief template. Close every kind A gap yourself. If a kind B gap is unanswered, batch-ask it (section 8) before going on. Record each requester gap you closed, so the requester improves.
1. **Frame.** In five sentences or fewer, restate the problem in plain language. State the tier, reversibility class, who is affected, and the cost of delay. Check the premise.
2. **Load context.** List, by ID, the strategic objectives, invariants, register rows, assumptions and open decisions that apply. If a dependency is open, say whether this decision can proceed on its reversible parts or must wait.
3. **Gate.** Test each option against HARD and FIRM invariants. A HARD break gates the option out. A FIRM break needs an explicit reason.
4. **Precedent.** Is the answer already settled by an Accepted decision, an invariant, a stated owner requirement (`01` section 8) or an established precedent in the codebase? If so, record "settled by precedent" and stop.
5. **Options.** At least three:
   - **Baseline:** do the minimum, or do nothing, or keep the status quo.
   - **The requester's candidates.**
   - **At least one derived option:** combine, split, reorder, defer with a named home, or buy instead of build.
   - **Decide later** is a legitimate option. State what it costs to wait.
6. **Evaluate.** Rate each option against the baseline on the criteria in section 6, from -2 to +2, with one sentence citing IDs. Do not add the ratings into a score. Name the criteria where options differ and any deal-breaker.
7. **Stress.**
   - **Sensitivity:** take the three assumptions with the greatest influence and the lowest grade. Ask whether the ranking changes if each is wrong by a factor of two.
   - **Pre-mortem:** assume the recommendation failed in twelve months. List the three most plausible causes and what would have caught them early.
8. **Recommend.** One option, or a staged path. Give the reasons in ten lines or fewer, plus confidence, what would change the recommendation, the cheapest experiment, consequences (what becomes true, blocked, unblocked), and a review trigger.
9. **Escalation gate** (section 7). This is mandatory and last.
10. **Record and update.** Write the record. The register updates (`03`, `04`, `05`, and `02` if a rule changed) are listed in the record. The decision agent applies them only if its instructions say so; otherwise the executor applies them after the challenger result is attached (section 11).

## 6. Criteria

Rate options against the baseline. Add criteria only with a reason.

| ID | Criterion | What to look at |
|---|---|---|
| C1 | **Invariant compliance** | A gate (step 3). Not rated |
| C2 | **Risk and safety** | Blast radius, failure modes, INV-S rows, recoverability |
| C3 | **Reliability** | Availability, behaviour under failure and scale, operability |
| C4 | **Unit cost** | Effect on the measures in [01](./01-strategy.md) section 6, at the full envelope and at 10% of it |
| C5 | **Time to value** | Effort, risk of delay, what it unblocks |
| C6 | **Simplicity and maintainability** | Moving parts, test cost, cognitive load, who can operate it at 2am |
| C7 | **Reversibility and optionality** | Cost of being wrong; what it keeps open |
| C8 | **Strategic fit** | Which SO items it advances or harms |

Ratings: -2 much worse than baseline, -1 worse, 0 same, +1 better, +2 much better.

- Add a column per option. The template shows three, but use as many as you have.
- **While the SO-1 targets are TBD**, rate C4 against the baseline and show cost as a range with a grade, plus the cost-to-revenue ratio where revenue is affected. Do not invent a target.
- A stated owner requirement in `01` section 8 is a gate, not a criterion.

## 7. Escalation gate

Run in order. Stop at the first that applies. State the result in the record using the exact phrase.

| Gate | Question | Result phrase | Owner involved? |
|---|---|---|---|
| G1 | Is it already settled by an Accepted decision, invariant, stated owner requirement or codebase precedent? | **Settled by precedent** | No |
| G2 | Does the recommended option violate an invariant, contradict an Accepted decision, or undermine a strategic objective? If **no** | **Settled within the rules** | No |
| G2 | If **yes** | **Needs ratification: violates / contradicts / undermines `<ID>`** | Yes, after the fact is acceptable for R0/R1 branch work |
| G3 | Do the rules and evidence fail to determine the answer, and is it R2 or R3? | **Needs owner: `<what is missing>`** | Yes, before acting |
| G4 | Is it a value judgment (budget, risk appetite, legal posture, brand) or a resource commitment beyond an approved plan? | **Needs owner: `<judgment>`** | Yes, before acting |

**Split decisions.** When part of a decision is settled and a later stage needs the owner, use two lines:

- `Settled within the rules for <scope>`
- `Needs owner: <judgment> before <stage>`

Do not hide the second line in a status qualifier, and do not let the later stage start on a measurement trigger alone.

Do not escalate because a topic feels consequential, product-flavoured or unfamiliar. Escalate because a named gate applies.

**What may proceed while waiting:** settled decisions proceed at once. "Needs ratification" decisions may proceed only as reversible (R0, R1) work on a branch or in staging. Nothing irreversible or production-affecting proceeds before the owner answers.

## 8. Questions policy

There are three channels. Use the right one.

| Channel | Who asks | When | Form |
|---|---|---|---|
| **Owner facts batch** | The requester, before submitting the brief (or the decision agent at step 0) | A kind B gap (section 4.1) | One message with all questions. For each: what I found, what I think the answer is, and "confirm or correct" |
| **Owner decision** | The decision agent | Gate G3 or G4 applies | Question. Why only you can answer. Recommended answer and reason. What happens under each answer |
| **None** | n/a | Reversible work; anything a check can settle; anything already recorded | Do not ask |

Rules:

1. Answer from evidence first. An owner question that a check could have answered is a failure.
2. Never ask the same question twice. Look in `01` to `05` first, and record each answer where it belongs (section 13).
3. Do not ask permission for reversible work, or ask the owner to choose between options the method can rank.

## 9. Confidence

| Level | Means |
|---|---|
| **High** | Key assumptions are grade V or P. Options are clearly separated. Consequences are reversible or already tested |
| **Medium** | Some key assumptions are I or T, with a named check planned. Options are separated but not by a wide margin |
| **Low** | A key assumption is G, or the options are within noise |

A Low or Medium recommendation must include the cheapest experiment and, where possible, a reversible interim step.

## 10. Review triggers

Every accepted decision names at least one measurable trigger (a threshold, an event or a date), for example "resident agents exceed 2,000", "memory per session exceeds 1.5 GB", "the spike fails". Show how each number was derived, or mark it provisional (grade G). The register carries the trigger. A sweep at each phase boundary (or monthly while pre-launch) scans for fired triggers and sets the row to `Review-triggered`.

## 11. Decision rights

| Decision | Who decides | Who is told |
|---|---|---|
| T0 | Executor | Nobody. Commit message |
| T1 | Executor, reviewed in the normal PR or plan review | Plan owner |
| T2 settled (G1 or G2 no) | Decision agent recommends, executor proceeds, owner sees the record afterwards | Owner via the record and register |
| T2 needs ratification, owner (G2 yes, G3, G4) | Owner | Everyone via the record |
| An owner statement of a decision | The owner (already decided) | Recorded in `03` with the stated reasons, no method run (section 13) |
| Change to `01-strategy.md` or `02-invariants.md` | Owner only | Everyone |
| Reopening an Accepted decision | Anyone, with a fired review trigger or new evidence, through a new T2 record | Owner |
| Applying register updates for a T2 record | The executor, after the challenger result is attached | Owner |

### Execution approvals (separate from decision approval)

**Confirmed by the owner, 2026-11-11:** every change to staging needs approval; read-only operations do not.

A decision being settled does not authorise acting on shared systems. The following need the owner's approval whatever the decision tier or gate result. They come from INV-O1, INV-O2, INV-O5, INV-P4 and INV-X1.

| Action | Approval |
|---|---|
| Any change to a shared environment, staging or production: deploy, configuration change, job submit or stop. (Basis: the continuity guardrail "shared environments are changed only with an explicit owner decision") | Owner, each time |
| Terraform apply, or any command that can write state or touch the backend | Owner, after the plan is read |
| Creating or deleting servers, load balancers or other cost-bearing resources | Owner |
| Destructive data operations | Owner |
| Reading or handling secrets beyond what the task needs | Owner |
| Changing `01-strategy.md` or `02-invariants.md` | Owner |
| Merging to `main` during the trading extraction (INV-P4, while active) | Owner |
| Read-only checks on staging (section 4.2) | None |

## 12. Anti-patterns

| Anti-pattern | What it looks like | Countermeasure |
|---|---|---|
| Deferral by "unknown" | A gap listed as "could not determine" when a check was possible | Section 4.1: kind A is checked, kind B is asked once, kind C becomes an assumption |
| Asking what the code says | A question to the owner that a file read answers | Section 8 channel rules |
| Asking twice | Re-asking a fact the owner already gave | Record answers at once; read `01` to `05` first |
| Leaning requester | The brief hints at the answer | Neutral brief; fresh decision agent |
| Over-escalation | "This feels important, ask the owner" | Gate G1 to G4 only |
| Under-escalation | Deciding an R2 or invariant-touching change alone | T2 triggers |
| Anchoring | Only the first idea gets analysed | Baseline plus a derived option |
| False precision | Weighted scores with decimals | Pugh ratings, ranges, grades |
| Fact-shaped guesses | An unverified number repeated until it feels true | Evidence grades; sensitivity step |
| Stale facts | Trusting a pending plan or a doc that code has overtaken | Evidence rule 5 and 8 |
| Grep as proof | "Nothing uses it" without a suite run | Evidence rule 3 |
| Consultant fog | Generic principles with no ties to IDs or facts | Every claim cites an ID or a path |
| Speculative generality | Building a universal engine for one real case | INV-E8; require two real consumers |
| Defer as explanation | A deferral invented to excuse a gap | INV-P2: name a home first |
| Goalpost drift | Weakening a check so the work counts as done | INV-P1: exit checks frozen first |
| Scope creep into implementation | The decision record turns into a design | Decision agent does not implement |
| Stale register | Relying on an old row | Read the source; flag staleness |

## 13. Recording

**Records.** The Decision Record in `records/` is the durable artefact for a T2 decision.

- **ID:** `D-<yyyy>-<nnn>-<slug>.md`. The executor allocates the next number by listing `records/`. Never reuse a number.
- **Length:** the record body should fit in about 150 lines. Put long evidence tables in an appendix section at the end.
- **Code state:** the record says which commit and environment its facts were verified against.
- **Challenger:** a T2 record is not final until the challenger result is attached (07 section 2).
- **Registers:** update `03`, `04`, `05` in the same change as the record.

**Owner decisions stated in plain words.** When the owner states a decision, the executor records it in `03` the same day, with the owner's reasons verbatim or closely paraphrased, the date, and any binding consequences for plans. No method is run unless the owner asks for one, or the decision contradicts a HARD invariant (then say so, and ask).

**Owner facts.** Record each answer immediately in `04` (assumption or limitation, grade O) or `01` (requirement).

### Records and ADRs

| | Decision Record (`docs/decisions/records/`) | ADR (`docs/tech/architecture/adrs/`) |
|---|---|---|
| Answers | Why we chose this, with options, evidence and review triggers | What is now true about the architecture |
| Covers | Any T2 decision: architecture, operations, billing, process | Lasting architectural outcomes only |
| Length | Up to about 150 lines plus appendix | One page |
| Status words | Recommended, Settled, Needs ratification, Needs owner, Ratified, Superseded | Proposed, Accepted, Superseded |
| Written | For every T2 decision | Only when the outcome changes the architecture for the long term |

Rules:

1. **The record holds the reasoning. The ADR links to it and does not repeat it.**
2. **The ADR is the authority for its own text and status.** The register (`03`) links to it and mirrors its status; if they differ, the ADR wins and the register is fixed.
3. **Superseding.** A record that supersedes an ADR marks that ADR `Superseded` (with a link) in the same change.
4. **Mapping.** Record Ratified or Settled becomes ADR Accepted. Record Recommended or Needs owner is not an ADR yet.
5. **IDs.** ADRs are identified by path (`ADR-<yyyy>-<mm>-<nnn>`) because the numbers repeat. Records use `D-<yyyy>-<nnn>`.
6. **Other places stay valid in scope.** Feature-folder `decisions/` briefs and Traderton's decision log remain authoritative for their epics. Decisions that bind more than one epic or repository go to `records/`.
7. The brief is transient. Keep it if it holds grounded facts that are costly to regather.
