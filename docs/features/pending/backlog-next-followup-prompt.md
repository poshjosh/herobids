backlog = docs/features/pending/backlog-next.md

GOAL

Sequentially address the code review comments for all the plans in <backlog>.

STEPS

1. Read <backlog>

2. Select the first plan that is marked IN_REVIEW

3. Mark the plan you selected as IN_PROGRESS

4. Read the code review observations related to the plan you selected. The code review observation is saved to a file named in this format: <plan-name>-REVIEW.md - For example, if the plan you selected was docs/features/pending/skill-tool-validation/001-plan.md, the code review observations would be at docs/features/pending/skill-tool-validation/001-plan-REVIEW.md - If you cannot find a related review file, goto Step 1.

5. Holistically address the code review observations. 

6. Verify what you addressed and fix problems if any.

7. Git add and commit the changes you made.

8. Mark the plan you selected as DONE

9. Goto Step 1

IMPORTANT

DO NOT STOP TILL ALL PLANS IN <backlog> HAVE BEEN TREATED