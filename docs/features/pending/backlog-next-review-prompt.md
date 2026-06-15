backlog = docs/features/pending/backlog-next.md

GOAL

Sequentially review all the plans in <backlog>.

STEPS

1. Read <backlog>

2. Select the first plan that is marked DONE

3. Mark the plan you selected as IN_REVIEW

4. Review the selected plan. Review the diff between the current git branch and the default branch. Review whether the selected plan has been fully implemented. Review the code and provide feedback on its completeness, functionality, quality, readability, and maintainability. Identify any potential issues or areas for improvement. If the code represents the implementation of a plan, check if the implementation aligns with the plan's specifications and acceptance criteria. Consider factors such as code structure, naming conventions, documentation, and adherence to best practices. Provide constructive criticism and actionable recommendations to help the developer improve their code.
Suggest specific changes to enhance the code. Outline the sequence of suggested changes in order. Output a numbered task list with:

- What to change (file path, function/component name)
- What the change is (add, modify, delete, etc)
- Dependencies between steps
- Any risks or open questions

Each item on the list should have a priority level (critial, high, medium, low). Each item on the list should also be actionable and specific. If there are any uncertainties or assumptions in your suggestions, clearly state them. Note what should be unit tested vs integration tested vs visually verified.

5. Save your review to a file alongside the plan you selected, in the format: <plan-name>-REVIEW.md - For example, if the plan you selected was docs/features/pending/skill-tool-validation/001-plan.md, save the review to docs/features/pending/skill-tool-validation/001-plan-REVIEW.md

6. Goto Step 1

IMPORTANT

DO NOT STOP TILL ALL PLANS IN <backlog> HAVE BEEN REVIEWED