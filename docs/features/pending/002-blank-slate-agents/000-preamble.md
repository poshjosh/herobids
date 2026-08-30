Much has been implemented since this was written. See:

- docs/features/2026/08/23/001-relaxed-agent-creation-form/001-plan.md
- docs/features/2026/08/28/002-dynamic-skill-management/001-plan.md
- docs/features/2026/08/28/003-execution-mode-immutability-and-go-live/001-plan.md
- docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md
- docs/features/2026/08/29/003-unified-skill-addressing/001-plan.md
- docs/features/2026/08/30/001-unified-skill-catalog/001-plan.md

---

The future of prompts, skills and connections

- Granting some connections should automatically add a skill to the granted agent. For example, granting an agent a Gmail connection should automatically assign the email skill. What do you think? Any caveats? What other skill could be automatically assigned?

- Agents should be able to manage own skills. There should be appropriate tools to enable the agent inspect existing skills and add/remove etc The problem is that some skills are in the agent's prompt already. One way to handle this is to exclude those skills in the agent's prompt from skill management. For example list_skills should not list skills which the agent already have. Also, load skill should not load such skills. Are there better ways to handle this? Any caveats?

- We are thinking of permiting a user to change the agents objective/goal. We could make use of telegram slash commands. What do you think? Any caveats? Any better way?
