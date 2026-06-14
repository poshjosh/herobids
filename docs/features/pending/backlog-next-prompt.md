backlog = docs/features/pending/backlog-next.md

GOAL

Implement all the plans in <backlog> sequentially.

STEPS

1. Read <backlog>

2. Select the first plan that is not yet marked DONE

   a. if there is one, go to Step 3

   b. if there is none, you have completed this task. STOP. DO NOTHING ELSE

3. Implement the selected plan

4. Add unit tests

5. Update documentation, if need

6. Decide if the plan warrants e2e like tests:

   a. if true, determine what e2e tests will fit and implement them. By e2e we mean functional, integration or the likes

   b. if untrue, go to Step 7

7. Review the code

8. Address the code review observations

9. Update CHANGELOG.md, keep it very brief

10. Git add and commit the code

11. Update <backlog> to indicate DONE against the plan you completed. For example: `1. DONE [Skill Tool Validation]`

12. Goto Step 1