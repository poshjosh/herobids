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