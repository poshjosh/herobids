# Decision Brief: <short title>

**Brief ID:** NNN
**Requester:** <human or agent>
**Date:** YYYY-MM-DD
**Verified against:** <commit hash> in `herobids` (and `traderton` if used), environment(s): <staging / production / local>
**Tier (your best guess):** T1 / T2
**Cost of delay:** <what happens if this waits a week, a month>
**Decision needed by:** <date or event, or "no deadline">

> Be neutral. Describe facts and options. Do not rank the options or hint at a lean.
> Do the homework first: check the code and docs, and ask the owner once for facts only they hold.
> Delete these notes before saving.

## 1. Problem (plain language, five sentences or fewer)

<what is wrong or what must be chosen, and why now>

## 2. The question

<one neutral question. No option implied.>

## 3. Context the requester knows applies

| Kind | IDs |
|---|---|
| Strategic objectives | SO-? |
| Service expectations (01 section 8) | SE-? |
| Invariants | INV-? |
| Register rows | P-? / C-? / ADR-? / T-? / D-? |
| Assumptions | A-? |
| Open decisions this depends on or blocks | OD-? |

The decision agent will find others. Missing IDs here are not a problem.

## 4. Grounded facts

Verifiable facts only. Each with its source (file and line, or command and result). Mark which environment it applies to.

| # | Fact | Source | Env | Grade |
|---|---|---|---|---|
| F1 | | | staging / production / both | V / P / O / T / I / G |

## 5. Candidate options (not ranked)

For each, state what it is and what it would involve. Do not say which is better.

- **Option A:** <...>
- **Option B:** <...>
- **Option C:** <...>

The decision agent may derive a better option, and must include a baseline.

## 6. Checked and open

### 6.1 Checked (the homework)

List what you looked up and what you found. Every gap you could close is here, with its answer.

| # | Question | How I checked (path, command) | Result |
|---|---|---|---|
| K1 | | | |

### 6.2 Owner facts asked (kind B)

Asked in one batch, with a proposed answer. Record the owner's reply and where you recorded it.

| # | Question | What I found | My proposed answer | Owner reply | Recorded in |
|---|---|---|---|---|---|
| Q1 | | | | | |

### 6.3 Not yet knowable (kind C)

Only gaps nobody can close today. Each is also a graded assumption in `04`, with the cheapest experiment.

| # | Gap | Assumption ID and grade | Cheapest experiment |
|---|---|---|---|
| N1 | | | |

## 7. Readiness checklist (tick before submitting)

- [ ] No gap in 6.3 could have been closed by a code read, a doc read or an allowed read-only command.
- [ ] Every kind B question has been asked, answered, and recorded.
- [ ] Plan documents I rely on were checked against `git log`.
- [ ] Each fact states its environment and the commit it was verified against.
- [ ] The options are unranked and the text contains no lean.

## 8. Constraints specific to this decision

<deadlines, budgets, dependencies, things already committed>

## 9. Out of scope

<what the decision agent should not decide here>
