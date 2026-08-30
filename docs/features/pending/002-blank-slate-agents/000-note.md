Much has been implemented since this was written. See:

- docs/features/2026/08/23/001-relaxed-agent-creation-form/001-plan.md
- docs/features/2026/08/28/002-dynamic-skill-management/001-plan.md
- docs/features/2026/08/28/003-execution-mode-immutability-and-go-live/001-plan.md
- docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md
- docs/features/2026/08/29/003-unified-skill-addressing/001-plan.md
- docs/features/2026/08/30/001-unified-skill-catalog/001-plan.md

---

We want agents to be able to dynamically manage skills. Read:

- docs/features/pending/002-blank-slate-agents/000-preamble.md
- docs/features/pending/002-blank-slate-agents/001-plan.md (this contains other requirement which we prefer not to include unless they are related and of low complexity)

There exists an ecosystem built around:

- [skills.sh](https://www.skills.sh) (public index)
- [vercel-labs/skills](https://github.com/vercel-labs/skills) (CLI)
- local skills folders (.agents/skills/)
- GitHub skill repos (e.g. https://github.com/twostraws/swiftui-agent-skill)

Notes

- We should publish all our skills publicly (find out how best to do this). Some of our skill reference tools which are internal, it may not make sense publishing those.
- Agents should be able to dynamically load and use skills

Below is how a skill for using the https://skills.sh ecosystem would look like

- install the cli: `npx skills`
- search for skills by keyword: `npx skills find <keywords>`. What this does:
  - queries the skills index
  - shows matching skills
  - displays install instructions
- install a skill: `npx skills add <owner/repo>`. For example: `npx skills add https://github.com/twostraws/swiftui-agent-skill`. What happens is:
  - repo is downloaded
  - skills are detected
  - files are copied locally
  - agent can use them

- some repos contain multiple skills. You can install one of such multiple skills using: `npx skills add <owner/repo> --skill <skill-name>`. For example: `npx skills add https://github.com/twostraws/swiftui-agent-skill --skill swiftui-pro` 

- see installed skills: `npx skills list`. This shows:
  - installed skills
  - target agent
  - install location

- remove a skill: `npx skills remove <skill-name>`

Open questions:

- is npx available by default for agents?
- what about other skill repositories/standards/setups?
  - https://agentskills.io/home
  - https://www.openagentskill.com/
  - https://awesomeskill.ai/
  - https://aregistry.ai/