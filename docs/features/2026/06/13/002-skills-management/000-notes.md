**Current State**

The repo already has basic skill management, but not a marketplace. Authenticated users can create, edit, delete, view, and fork skills via skills.ts, backed by the current schema in skills.ts. The existing contract is “own + public + built-in” under a single `/skills` list, as described in 000-plan.md and rendered very simply in SkillsPage.tsx.

Two design gaps matter immediately. First, the current model overloads visibility: the agent builder treats every non-base skill returned by `/skills` as selectable in agent-display.ts, which is incompatible with priced marketplace items. Second, deleting a skill row causes the runtime to stop resolving it for any agent that references it, because missing stored skills are silently skipped in agent-runtime-descriptor.ts. So marketplace work is not just list/filter UI; it needs a cleaner content lifecycle model.

**Recommended Answers**

1. Should marketplace publication reuse the current `public` flag?
Recommended answer: no. Keep ownership/system state separate from publication state. `visibility` alone is too overloaded for “private draft”, “marketplace listed”, “system built-in”, and “selectable by agents”.

2. What should the core model be?
Recommended answer: extend `skills` with marketplace fields rather than inventing a second content table.
Minimum additions:
- `publicationStatus`: `draft | published | delisted`
- `publishedAt`
- `priceCents`
- `autoPublishedByPlan`
- `archivedAt` or another soft-delete marker

3. How should free-plan auto-publish work?
Recommended answer: make it a plan entitlement, not a hardcoded `if planId === 'free'`.
The current plan config in schema.ts only models quotas and usage packaging. Add a nested skills entitlement block such as:
- `autoPublishCreatedSkills`
- `canKeepSkillsPrivate`
- `canChargeForSkills`
That matches the broader direction in your scratchpad and avoids baking product policy into route handlers.

4. How should admin visibility work?
Recommended answer: use the existing auth decorations from auth.ts. Admins should bypass publication filters and see all skills, including drafts and delisted items, but that should affect listing/query scope only, not ownership rules.

5. How should likes work?
Recommended answer: add a `skill_likes` table with `unique(skill_id, user_id)` and a denormalized `likeCount` on `skills`.
Rules:
- one active like per user per skill
- authors cannot like their own skills
- like/unlike should be idempotent
- marketplace lists should sort off the denormalized count or a precomputed metric, not a live aggregation on every request

6. How should price work?
Recommended answer: decide whether price is real entitlement logic or just display metadata. If users can set a price but everyone can still fork/use the skill, price is cosmetic.
If price is real, you need a `skill_entitlements` or `skill_purchases` table and “selectable by agent” must mean:
- built-in skill, or
- skill owned by the user, or
- free published skill, or
- paid skill the user has acquired

7. How should popularity be determined?
Recommended answer: do not sort by raw lifetime likes. That turns into “oldest item wins”.
Best practice here is a rolling, log-scaled composite score with recency bias and unique-user metrics:

$$
\text{popular} =
0.45 \cdot \ln(1 + \text{distinctUsers90d}) +
0.25 \cdot \ln(1 + \text{likes90d}) +
0.20 \cdot \ln(1 + \text{sessionStarts90d}) +
0.10 \cdot \ln(1 + \text{forks90d})
$$

And separately:

$$
\text{trending} =
\text{same shape, but over 7d or 30d with stronger recency decay}
$$

That gives you two useful sorts:
- `popular`: durable adoption
- `trending`: recent momentum

8. Can current data support usage-based popularity?
Recommended answer: not accurately enough. Today a skill’s usage is indirectly inferred from `agents.skillIds`, but agent edits rewrite history. If you want “how often used” to mean anything, you need immutable usage facts.
The clean options are:
- add `skill_usage_events`, or
- snapshot `skillIds` onto each agent runtime session at session start

I would prefer immutable usage events because they support later analytics without retroactive distortion.

9. How should edit/delete behave for published or in-use skills?
Recommended answer: do not hard-delete live marketplace content. At minimum use soft delete for published skills and block deletion when a skill is referenced by active agents. Better still, add revisions so edits do not silently mutate historical behavior for existing agents.

10. What should the API shape be?
Recommended answer: stop using one undifferentiated `/skills` feed for everything.
Split by intent:
- `/skills?scope=mine`
- `/skills?scope=marketplace`
- `/skills?scope=selectable`
- `/skills/:id/publish`
- `/skills/:id/unpublish`
- `/skills/:id/like`
That is much cleaner than stretching the current mixed list.

**Open Questions**

1. Does a priced skill grant actual reuse rights, or is price only display metadata? This is the main product blocker.
2. Should marketplace visitors see full `instructions`, or only a preview until acquisition? Full visibility is probably wrong for paid skills.
3. Should free-plan auto-publish be mandatory on every create/update, or just the default on create with no opt-out?
4. Should editing a published skill mutate the live listing, or create a new revision while existing agents stay pinned?
5. Should built-in/system skills appear inside the marketplace at all, or remain a separate library section? I recommend separate.
6. Should old `public` user skills be backfilled to `publicationStatus=published` during migration, or treated as drafts and re-published explicitly?