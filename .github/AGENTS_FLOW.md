# AGENTS FLOW

```
Contemplator → PlanCreator → Implementer → UnitTester → CodeReviewer
                                                              │
                                                        pass / fail
                                                        │         │
                                                  VisualTester  Implementer (rework)
                                                        │
                                                  pass / fail
                                                  │         │
                                                Tester   BugFixer → Tester → CodeReviewer
```       

| Agent | Handoff triggered | Condition |
|-------|------------------|-----------|
| **BugFixer** | "Add Tests" → Tester | After fixing — unless fix is config/docs-only with no testable path |
| **Implementer** | "Unit Tests" → UnitTester | After successful implementation (default) |
| | "Review Code" → CodeReviewer | Only if change is non-functional (no logic to test) |
| | "Contemplate" → Contemplator | When blocked by a design ambiguity |
| **CodeReviewer** | "Rework" → Implementer | If critical/high/medium issues found |
| | "Visual Test" → VisualTester | If review passed + frontend code involved |
| **Contemplator** | "Create Plan" → PlanCreator | When all critical questions are resolved |
| **PlanCreator** | "Implement Plan" → Implementer | When plan is complete with no unresolved blockers |
| **UnitTester** | "Review Code" → CodeReviewer | After all tests pass |
| **Tester** | "Review Code" → CodeReviewer | After all tests pass |

The full pipeline chain is: **Contemplator → PlanCreator → Implementer → UnitTester → CodeReviewer → VisualTester/Rework**.
