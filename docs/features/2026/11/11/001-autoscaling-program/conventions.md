# Conventions: how the work is done

**Read once per session.** These rules exist for three things: clarity (anyone can see where we are), continuity (a new agent picks up without a gap), autonomy (the agent keeps moving without waiting for the owner).

## 1. Statuses

One vocabulary for tasks, feature plans and milestones.

| Status | Meaning | Required with it |
|---|---|---|
| `planned` | Named, not yet detailed | Nothing |
| `ready` | Detailed, exit checks frozen, can start | The plan or README exists |
| `in_progress` | Someone is working on it now | Who and when, in the journal |
| `blocked` | Cannot proceed | The blocker: an `OD-nn` (open decision), an inbox item `I-nnn`, or a named dependency |
| `deferred` | Consciously postponed | **A named home**: the milestone, plan or `OD-nn` where it will land (INV-P2). No home, no deferral |
| `done` | The exit check passes as a behaviour of the running system | The evidence: a test run, a log line, a command result |
| `dropped` | Will not be done | The reason and who decided |

"Done" is a behaviour, not an artifact (INV-P1). A written file is not a delivered feature. A partial result is `in_progress` or `blocked`, never `done`.

## 2. Where status lives, and the update order

| Level | Where the status is the truth | Detail |
|---|---|---|
| Task | The task table in the feature plan (`plan.md`) | A row per task |
| Feature plan | The features table in the milestone `README.md` | One row per plan |
| Milestone | [milestones.md](./milestones.md) | One row per milestone |

**Update bottom-up and in the same change:** task first, then the plan row, then the milestone row if it changed. Never record the same status in two places that are both "the truth". Parents summarise; they do not copy detail (INV-P3).

## 3. Just-in-time planning

We do not write all the plans up front. Plans written early go stale, and the first discoveries change the rest.

1. **Only the active milestone has a folder.** A milestone gets its folder and `README.md` when it starts (use `templates/milestone-readme.md`). Before that it is one row in `milestones.md`.
2. **Only one feature plan is `ready` ahead of the one in progress.** Draft the next plan when the current one is on its last phase, or when it is blocked and nothing else is unblocked. Use `templates/feature-plan.md`.
3. **A plan is one reviewable change set.** About ten tasks or fewer. If it grows, split it and make the second part a new plan.
4. **Freeze exit checks when a plan or milestone becomes `ready`.** Only the owner may change them afterwards. If a check turns out wrong, add a note and ask in the inbox; do not rewrite it to fit the result (goalpost drift).
5. **Draft from what we learned.** A new plan starts from the previous plan's "Next plan hint", the journal, the registers in `docs/decisions/`, and the design references (for example Plan 005). Never from memory.
6. **Starting the next milestone:** create its folder, write its README with frozen exit checks, then draft only its first feature plan.

## 4. Decisions as they arise

Use the framework in [docs/decisions/](../../../../../decisions/README.md). Do not invent a parallel process.

1. **Choose the path** with "Which path does a decision take?" in the decisions README.
2. **T0:** decide and carry on. **T1:** write a short note in the feature plan's "Decisions" section. **T2:** write a brief, run a decision agent and a challenger, record it in `docs/decisions/records/`, and link the `D-` ID from the plan.
3. **Read before you decide:** the registers `03`, `04`, `05` and the "decisions every plan must carry" table. Check that the answer is not already settled.
4. **Never stall on a decision.** Mark the dependent task `blocked` with the `OD-nn`, then take the next unblocked task or draft the next plan. A decision that only the owner can make goes to the inbox with a recommended answer.
5. **Check before you ask.** Look in the code, docs and allowed read-only systems first. Facts only the owner holds are asked once, in a batch, with a proposed answer.
6. **Record at once:** decisions in `03`, assumptions and limits in `04`, new open decisions in `05`. The register update is part of finishing the task.

## 5. Approvals and the owner inbox

A settled decision does not authorise acting on shared systems. These need the owner's approval (decisions `06` section 11): any change to staging or production; Terraform apply; creating or deleting paid resources; destructive data operations; secrets beyond need; edits to `01-strategy.md` or `02-invariants.md`. **Read-only checks do not need approval.**

When you reach one:

1. Add an item to [owner-inbox.md](./owner-inbox.md): what, why, the exact commands, the expected effect, the rollback, and how you will verify.
2. Mark the task `blocked` with the inbox ID.
3. **Keep working** on the next unblocked task. Do not wait idle.
4. At each session start, read the inbox for replies and unblock what was approved.

Batch approvals: group related actions into one item so the owner decides once.

## 6. Quality gates for every plan

- Carry the decisions that apply: the register's "Decisions every plan must carry" table (today C-12, C-13, SE-1).
- State rollback and verification.
- Run the focused tests, then `pnpm lint` and the relevant build or the infra suite, before declaring work done (INV-E9).
- Terraform: `TF_DATA_DIR=.terraform-envs/<env>`, plan first, read it, never apply without approval (INV-O1, INV-O2).
- Environment variables: update the matching `.example` file in the same change (INV-X1).
- Investigate before fixing: read related docs, `docs/bug-reports/`, and `git log` for the affected files (INV-E6).
- If an approach fails twice, stop patching: diagnose the root cause and try a different approach.

## 7. Session protocol

**Start**
1. Follow the resume protocol in the [README](./README.md).
2. Check the inbox for replies.
3. Check that the code state still matches what the plan says (`git log`, `git status`). Re-verify any fact older than a day if it drives your next step.

**End** (also after any long task)
1. Update task, plan and milestone statuses, bottom-up.
2. Append a journal entry (format below).
3. Add owner items to the inbox.
4. Update `docs/decisions/` registers for anything decided or learned.

**Journal entry format** (about ten lines, append at the bottom)

```text
## YYYY-MM-DD HH:MM  <agent or person>
Worked on: <plan and task IDs>
Done: <what changed, with links or commit hashes>
Decided: <D-/C-/OD- IDs, or "none">
Learned: <facts that change later work>
Next action: <the single next step>
Blocked on: <IDs, or "nothing">
```

## 8. Stop conditions (the only reasons to halt and hand back)

1. A HARD invariant would be broken and no compliant option exists.
2. The only way forward is an action that needs approval **and** no other unblocked work exists. Put the item in the inbox first.
3. An exit check cannot be met and the owner must decide whether to change it.
4. A discovery contradicts an owner decision or a service expectation (for example SE-1).
5. A Terraform plan shows an unexpected destroy, or a secret has been exposed.
6. The same approach has failed twice and the root cause is still unknown after diagnosis.

Anything else: decide, record, and continue.

## 9. Risks

There is no separate risk register. Risks live where they can be acted on:

- **Beliefs we are unsure of** go in the assumptions register (`docs/decisions/04`), with how to verify.
- **Risks to a milestone** go in that milestone's README, three to five lines each: what could go wrong, how we would notice, what we do.
- **Risks of a decision** go in its Decision Record (sensitivity and pre-mortem).
- **Risks to a plan** go in the plan's "Risks" section.

A central risk document would duplicate these and drift (INV-P3). If a risk crosses milestones, record it in the journal and in each affected milestone README.

## 10. Keeping documents honest

- Link, do not copy. If text exists in two places, one is already wrong.
- When a plan supersedes an older document, add a pointer in the old one. Do not delete without the owner's approval.
- State the commit and environment a fact was verified against. Facts about staging and production differ.
- If you find a stale statement, fix it or flag it in the journal. Do not rely on it.
