---
name: review-rework
description: 'Review, then rework till only MEDIUM or LOW issues remain'
argument-hint: 'Plan or task-list to review, then rework the code against'
---

AGENTS

- CodeReviewer = .github/agents/CodeReviewer.agent.md
- Implementer = .github/agents/Implementer.agent.md

STEPS

1. Trigger/Handoff to **CodeReviewer"** to review the code with respect to the plan or task-list.

2. Wait for **"CodeReviewer"** to signal completion.

   a. If the code review includes critical/high issues/observations, go to Step 3 with the code review feedback as the target/argument.

   b. If the code review does not include critical/high issues/observations, go to Step 6.

3. Trigger **"Implementer"**.

4. Wait for **"Implementer"** to signal completion.

5. Go to Step 1.

6. Git add and commit the changes. 

7. Display the outstanding issues from the last code review (which must not include critical/high issues).
