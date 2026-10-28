// ── Slug helpers ────────────────────────────────────────────────────────────

/** Convert a human-readable name to a kebab-case slug component. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')  // strip non-alphanumeric (keep spaces, hyphens & underscores)
    .replace(/[\s_-]+/g, '-')       // collapse whitespace/underscores/hyphens to single hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens
}

/** Build a full skill slug: `<authorHandle>/<slugified-name>`. */
export function buildSkillSlug(authorHandle: string, name: string): string {
  return `${authorHandle.toLowerCase()}/${slugify(name)}`;
}

// ── Source kind ──────────────────────────────────────────────────────────────

export type SourceKind = 'system' | 'user' | 'external';

// ── Skill definitions ───────────────────────────────────────────────────────

/**
 * System skill definitions — seeded at deploy time.
 * Each skill defines what tools and context sections an agent can access.
 *
 * The `base` skill is auto-injected at runtime and NOT stored in the DB.
 * All other skills are stored as rows in the `skills` table.
 */

export interface SkillDefinition {
  id: string;
  /** Unique human-readable slug: `author/name` (e.g. `system/programming`). */
  slug?: string;
  /**
   * The installed skills.sh source ref (`owner/repo/skill`, D11) this skill
   * resolves from. Set for external skills.sh skills (Phase 4 T4). The
   * backend-approval resolver matches `sourceRef` against each registered
   * backend's `approvedSourceSkillRefs`; a match drives tool exposure from the
   * backend's MCP `tools/list`. Absent for `system/*` skills.
   */
  sourceRef?: string;
  /** Optional skill revision — incremented when the definition changes materially. */
  revision?: number;
  name: string;
  description: string;
  instructions: string;
  /** Optional hint shown to the creator near the agent goal/prompt field —
   *  describes what kind of goal works well with this skill. */
  promptHint?: string;
  /** Optional starter text pre-populated in the agent goal field.
   *  Takes priority over promptHint for in-field display. */
  promptTemplate?: string;
  requiredTools: string[];
  capabilityFamilies: string[];
  bindingRequirements: Record<string, {
    minBindings: number;
    requireReady: boolean;
  }>;
  contextRequirements: string[];
  requiredContextBlocks: string[];
  promptRendererHints: string[];
  requiredGuardrails: string[];
  suggestedTickIntervalMs: number;
  visibility: 'public' | 'private';
}

/**
 * `base` skill — auto-injected at runtime for every agent.
 * Provides memory, messaging, cost-awareness, and introspection tools.
 * NOT stored in DB; merged into any agent's capability set at tick time.
 */
export const BASE_SKILL: SkillDefinition = {
  id: 'base',
  slug: 'system/base',
  name: 'Base',
  description: 'Core tools: memory, tasks, reminders, messaging, cost tracking, and schema fetching. Auto-injected into every agent.',
  instructions: `You have access to core tools.

Use memory to remember information across ticks/sessions. For example, if you need to recall something from an earlier tick/session. You can:
- Use \`set_memory\` to persist a value by key across ticks.
- Use \`get_memory\` to retrieve a previously stored value by key.
- Use \`list_memory_keys\` to list all stored memory keys.
- Use \`delete_memory\` to remove one or more memory keys.

Use tasks to manage your work. You can:
- Use \`create_task\` to create a durable task with a title, optional notes, and optional due datetime.
- Use \`list_tasks\` to list your current tasks and their status.
- Use \`resolve_task\` to find a task ID by title before calling complete_task when you don't have the exact UUID.
- Use \`complete_task\` to mark a task as completed by its ID.

Use reminders for repeating work. You can:
- Use \`schedule_reminder\` to schedule a reminder at an absolute datetime. The reminder reaches you at that time with structured context; when it arrives you may need to take action based on that context (e.g. send a message).
- For work that repeats on a schedule, you can schedule it once with \`schedule_reminder\` using \`repeatEveryMinutes\` and a stable \`key\` (e.g. \`daily_report\`). The platform schedules each next occurrence for you, including across restarts. Scheduling again with the same \`key\` replaces that reminder instead of adding a second one.
- Your scheduled reminders are listed in your context. You can also use \`list_reminders\` to check them and \`cancel_reminder\` to stop one by its id or key.
- A routine is normally done when its reminder arrives. On other ticks, you can check your scheduled reminders before doing routine work early.
- You can record each completed run with \`set_memory\` so you can tell whether an occurrence was handled.
- When a reminder reports missed occurrences, you can decide whether one catch-up run is enough.

Use skills to gain additional capabilities/expertise. For example, if you have a task but are not sure how to accomplish it, you can search for, then add skills related to the task:
- Use \`list_skills\` to see what skills you currently have. Skills are identified by their slug (e.g. system/programming).
- Use \`search_skills\` to find skills by keyword. It searches both the system skills/platform catalog and external skills.
- Use \`add_skills\` to add skills by slug. Dependencies are added automatically unless you set includeDependencies to false. External skills (e.g. traderton/skills/crypto-trading) are installed into your workspace, and listed in your prompt by name and description.
- Use \`read_skill\` to read-in the instructions of an already added/installed external skill on demand. A read skill stays available for the rest of the session. Do not call \`read_skill\` for system skills.
- Use \`load_skill\` to call both \`add_skills\` and \`read_skill\` for a skill, ensuring it is added and its instructions are loaded.
- Use \`remove_skills\` to drop skills by slug.
- When the user asks for something you have no skill for, do not stop silently. Use the skill related tools listed above before you act.
- Some goals cannot be finished in one tick/session. Check this before you start: the goal has several units or steps, sets a per-tick limit or continuation delay, asks for ongoing or recurring monitoring, or has a step that must wait for a later tick. For these, use \`add_skills\` with \`system/long-running-task\` before you start work. It explains how to track progress in tasks and memory so you can continue across ticks and after a restart. Its dependencies, such as \`system/file-management\`, are added automatically.

Request connections to external providers when a task or skill needs one:
- Use \`list_providers\` to see which providers exist, what they can do, and whether the user already has an active connection you could reuse.
- Use \`request_connection\` to ask the user to create or approve a connection. It returns a short-lived link; forward that link to the user promptly with \`send_message\` and do not persist it beyond that message. The link expires, so tell the user to act soon.
- When a tool fails with \`connection.missing\`, you likely need a connection for that provider: call \`list_providers\` (with a capability hint if you know it), pick the matching provider, then call \`request_connection\` and send the link to the user.
- When a tool fails with \`connection.provisioning\`, a connection is already being set up — retry shortly; no request is needed.
- You will be woken when the request is completed, declined, or expires. On completion, continue with the task; on decline or expiry, ask the user whether to try again or offer an alternative.
- Never ask the user to paste secrets (API keys, passwords, private keys) into chat — they are entered only through the secure connection form.

When a tool fails, its result includes \`errorOwner\`, which says who can resolve the problem:
- \`platform\`: a platform problem that neither you nor the user can fix. Do not retry. If \`adminNotified\` is true, tell the user briefly what is not working, that the system admin has been informed, and that you are waiting. If \`adminNotified\` is false, tell the user briefly what is not working and that you cannot continue until the platform is fixed. Never say the admin was informed unless \`adminNotified\` is true. Leave out technical error detail.
- \`user\`: the user can resolve it. Tell the user what they need to do. 
- \`agent\` or absent: correct your input or approach and try again.

You can also:
- Use \`publish_artifact\` to publish structured outputs.
- Use \`send_message\` to communicate important updates, alerts, or status reports to the user. Set messageClass to "alert" or "reminder" to indicate urgency; "routine" is the default. Use contextRef to link the message to a specific context. Use \`send_email\` for email delivery.
- Use \`message_peer_agent\` to send a message to another agent of the same user, by its id or exact name. A message from another agent reaches you tagged [PEER ...]. Reply to a peer with \`message_peer_agent\`, and to your user with \`send_message\`.
- Use \`get_schema\` to fetch JSON Schema for a named config parameter or tool sub-schema. Call with name="all" to list available schemas before constructing config payloads.

Always send the user a message that says what you are doing and, if you need something from them, what it is. Do not ask the user to fix a problem only the platform can fix.

Communicating with users:
- Use plain language. Where a technical term is useful, include it and explain it in plain words the first time you use it.
- Ask at most two questions per message, unless the user has asked for more.
- When you need a decision for single questions, recommend a default and say the user can reply "yes" to accept it.
- Present choices as a numbered list so the user can reply with a number.`,
  requiredTools: ['send_message', 'publish_artifact', 'set_memory', 'get_memory', 'list_memory_keys', 'delete_memory', 'get_schema', 'list_skills', 'list_providers', 'request_connection', 'update_my_prompt', 'add_skills', 'remove_skills', 'search_skills', 'read_skill', 'load_skill', 'create_task', 'list_tasks', 'resolve_task', 'complete_task', 'schedule_reminder', 'list_reminders', 'cancel_reminder', 'message_peer_agent', 'read_agent_document'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
};

// Phase 4 (D21/D26): the three built-in trading skill definitions and their
// source-ref map have been removed. Trading skills are now external skills.sh
// skills (`traderton/skills/crypto-*`), installed at agent start and discovered
// over MCP. Herobids holds no trading skill text.

/** Id of the user-only children skill. See {@link USER_ONLY_SKILL_IDS}. */
export const CHILD_AGENT_MANAGEMENT_SKILL_ID = 'child-agent-management';

/**
 * `child-agent-management` skill — creates and manages the child agents an agent creates.
 * Assignable only by the user: an agent may not add it to itself, and may not grant it to a child.
 */
export const CHILD_AGENT_MANAGEMENT_SKILL: SkillDefinition = {
  id: CHILD_AGENT_MANAGEMENT_SKILL_ID,
  slug: 'system/child-agent-management',
  name: 'Agent children management',
  description: 'Create, list, inspect, pause, stop, message and delete the child agents you created.',
  instructions: `You can create child agents and manage the ones you created.

- Call \`list_child_agents\` first to get the IDs of your children. Do not guess IDs.
- Use \`create_child_agent\` only when a separate, focused goal needs its own agent. The child starts when you create it. Pass \`start: false\` to create it stopped.
- A retry of \`create_child_agent\` with the same name returns the existing child with \`duplicate: true\`. Nothing is created or started again, so do not create another child to retry.
- Use \`get_child_agent_status\`, \`pause_child_agent\`, \`stop_child_agent\` and \`message_child_agent\` only on your direct children.
- A child's \`lastStartRefusal\` (shown by \`list_child_agents\` and \`get_child_agent_status\`) means the platform refused to launch it after a start, for example for credit or a usage limit. Its \`code\` and \`message\` say why. You cannot start a child yourself: it stays stopped until the user starts it. Tell the user the reason and do not keep checking or create a new child to retry. \`lastStartRefusal\` is null when the last launch succeeded.
- Use \`delete_child_agent\` only on a direct child you no longer need. Deletion is permanent. The child must have no children of its own. A running child is stopped first. Pass \`stopFirst: false\` to refuse the delete while the child runs instead.

- Only create child agents when necessary. One example is complex tasks that cannot be handled effectively by a single agent.
- You are solely responsible for the child agents you create, unless the user explicitly takes over their management.
- Give child agents clear, achievable and verifiable objectives.
- Guide your child agents to achieve their objectives(s). 
- Maintain communication with child agents. Also require each child agent to maintain communication with you.
- Once a child agent is done, you may delete them or assign some other objective(s) to them. Do not leave them running with no task.`,
  requiredTools: [
    'create_child_agent',
    'list_child_agents',
    'get_child_agent_status',
    'pause_child_agent',
    'stop_child_agent',
    'message_child_agent',
    'delete_child_agent',
  ],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: [],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
};

/**
 * `programming` skill — code execution tools.
 */
export const PROGRAMMING_SKILL: SkillDefinition = {
  id: 'programming',
  slug: 'system/programming',
  name: 'Programming',
  description: 'Code execution tools',
  instructions: `You have access to programming tools for code-driven automation, external API calls etc.

- Use \`execute_code\` to run JavaScript or Python for custom automation, external API calls, analysis, data processing etc.
- Use \`execute_shell\` to run shell commands for git operations, build tools, package management, and system tasks.
- The tools available to you depend on your permission level. If \`execute_shell\` is not available, use \`execute_code\` instead.
- The tools support JavaScript/Node.js and Python runtimes as well as optional dependency installation.
- The tools return stdout/stderr so you can inspect execution results directly.
- Code can access the public internet.`,
  requiredTools: ['execute_code', 'execute_shell'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: 'Describe what automation or data processing the agent should perform (e.g., "Fetch token prices hourly and log them to a workspace file")',
};

/**
 * `file-management` skill — workspace file read, write, list, and delete.
 */
export const FILE_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'file-management',
  slug: 'system/file-management',
  name: 'File Management',
  description: 'Manage a per-agent workspace for intermediate files and outputs.',
  instructions: `You have access to workspace file-management tools.

- Use \`write_file\` to create or overwrite a file under the agent workspace.
- Use \`read_file\` to inspect file contents.
- Use \`list_files\` to inspect workspace directories and discover available files.
- Use \`delete_file\` to remove files you no longer need.
- Use \`stat_file\` to check if a path exists, whether it is a file or directory, and its size before calling read_file, list_files, or delete_file.

Workspace rules:
- Workspace files persist across ticks in the same runtime.
- Workspace files do not persist across runtime restarts.
- The \`sandbox\` directory is reserved for code execution internals.
- For data that must survive runtime restarts, memory tools from the base skill are the durable storage path.`,
  requiredTools: ['write_file', 'read_file', 'list_files', 'delete_file', 'stat_file'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: 'Describe what files or outputs the agent should maintain (e.g., "Keep a daily trading journal in workspace/journal/")',
};

/**
 * `web-access` skill — internet search, URL reading, and document fetching.
 */
export const WEB_ACCESS_SKILL: SkillDefinition = {
  id: 'web-access',
  slug: 'system/web-access',
  name: 'Web Access',
  description: 'Search the internet, read web pages, fetch documents, and make structured HTTP requests for research and information gathering.',
  instructions: `You have access to internet research tools.

- Use \`search_web(query)\` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use \`browse_url(url)\` to fetch and read the contents of a specific web page. Only \`https://\` URLs are allowed.
- Use \`read_document(url)\` to fetch and extract text from a document URL (e.g. PDF). Only \`https://\` URLs are allowed.
- Use \`make_http_request\` to make structured HTTP requests (GET, POST, PUT, PATCH, DELETE, HEAD) to external APIs. Returns status, headers, and truncated body. Useful for calling REST or GraphQL APIs with custom headers and authentication.
- Use \`send_message\` to share findings with the user.
- Use \`publish_artifact\` when findings are substantial enough to warrant a structured output.`,
  requiredTools: ['search_web', 'browse_url', 'read_document', 'make_http_request', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: "e.g. 'Research the best noise-cancelling headphones under $200 and send me a comparison'",
};

// WP7 (D8): the `task-management` system skill has been removed. Its task and
// reminder tools (create_task, list_tasks, resolve_task, complete_task,
// schedule_reminder, plus list_reminders and cancel_reminder) now live in
// BASE_SKILL, auto-injected into every agent. Old references fail soft (API
// create/update, add_skills, descriptor resolution) and migration 0073 drops
// the persisted rows.

/**
 * `email` skill — send emails on behalf of the user.
 *
 * Send-only for now — inbox-read (`search_emails`) is deferred until the
 * `gmail.readonly` OAuth scope is reintroduced after Google review approval.
 */
export const EMAIL_SKILL: SkillDefinition = {
  id: 'email',
  slug: 'system/email',
  revision: 1,
  name: 'Email',
  description: 'Send emails on behalf of the user.',
  instructions: `You can send email on the user's behalf.

- Use \`send_email(to, subject, body)\` to send emails. You may include cc and bcc recipients.
- The prompt context lists your granted email connections under "Email Connections" — check it for available \`fromConnectionId\` values.
- If you have multiple email connections, use \`fromConnectionId\` to select a specific sender. Omit \`fromConnectionId\` to use the default connection (marked [DEFAULT]).

Examples:
- "Email bob@example.com the weekly summary" → send_email
- "Message me when the position closes" → send_message
- "ETH just dropped below $2000 — alert me" → send_message with messageClass="alert"

Rule: Use send_email for any external email recipient. Use send_message for communicating with the user.`,
  promptHint: "e.g. 'Forward any invoice from the accounting firm to my personal inbox'",
  requiredTools: ['send_email'],
  capabilityFamilies: ['email'],
  bindingRequirements: {
    email: { minBindings: 1, requireReady: true },
  },
  contextRequirements: [],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: [],
  suggestedTickIntervalMs: 300_000, // 5 min — email is not real-time
  visibility: 'public',
};

/**
 * `platform-docs` skill — read platform documentation, schemas, and mappings.
 * Used by the onboarding chat agent and any agent that needs to understand
 * platform capabilities, form schemas, or configuration options.
 */
export const PLATFORM_DOCS_SKILL: SkillDefinition = {
  id: 'platform-docs',
  slug: 'system/platform-docs',
  name: 'Platform Docs',
  description: 'Search and read platform documentation, form schemas, and configuration references.',
  instructions: `You have access to platform documentation tools.

- Use \`list_app_docs\` to discover available documentation pages, schemas, and references.
- Use \`search_app_docs(query)\` to search for specific topics across all docs.
- Use \`read_app_docs(id)\` to read a specific document or schema by its ID.

Use these tools to answer user questions about platform capabilities, guide them through agent creation, explain configuration options, and help them understand connection types, venue options, and risk settings.`,
  requiredTools: ['search_app_docs', 'list_app_docs', 'read_app_docs'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: [],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
  promptHint: 'Ask me about platform features, agent configuration, or how to get started.',
};

/**
 * `browser` skill — interactive browser automation via a shared browser pool.
 * Separate from web-access because browser sessions have different resource
 * requirements and cost — the agent should explicitly opt in.
 */
export const BROWSER_SKILL: SkillDefinition = {
  id: 'browser',
  slug: 'system/browser',
  name: 'Browser',
  description: 'Interactive browser automation: open pages, click, fill forms, take screenshots, and read page content.',
  instructions: `You have two browser automation options.

**browse_interactive**

Actions: open, snapshot, click, fill, screenshot, get_text, close.
Single session per agent. Structured JSON responses.

Strengths:
- Native tool — no shell needed
- Snapshot returns a compact accessibility tree (cheap, fast, directly actionable)
- Screenshot returns base64 PNG (use when you need visual verification; requires vision)

Limitations:
- Single session only — cannot run parallel browser sessions
- No command chaining or background execution
- No named sessions

**agent-browser CLI**

Requires the system/programming skill. Run commands via execute_shell.

\`\`\`
execute_shell({ command: 'agent-browser open https://example.com' })
execute_shell({ command: 'agent-browser snapshot -i' })
execute_shell({ command: 'agent-browser click @e2' })
execute_shell({ command: 'agent-browser close' })
\`\`\`

Strengths:
- Named sessions (--session <name>) — run multiple independent browser contexts
- Command chaining (&&) and parallel execution (&, wait)
- Element refs (@eN) from snapshots for precise interaction
- Full command set (hover, drag, scroll, pdf, eval, etc.)

Limitations:
- Requires system/programming skill for execute_shell access
- Output is plain text (stdout/stderr), not structured JSON

Run agent-browser --help for the full command list.
Always close browser sessions when done to free resources.

When following a skill's instructions, prefer whichever browser automation option the skill suggests.`,
  promptHint: "e.g. 'Navigate to a website, fill out a form, and capture the results'",
  requiredTools: ['browse_interactive', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * `long-running-task` skill — continuity for goals that span many ticks.
 * Progress lives in durable tasks and memory so an agent can resume after a
 * restart. Workspace files are scratch only (they do not survive restarts); the
 * file tools below exist so dependency inference pulls in `file-management`.
 */
export const LONG_RUNNING_TASK_SKILL: SkillDefinition = {
  id: 'long-running-task',
  slug: 'system/long-running-task',
  name: 'Long-Running Task',
  description: 'Make steady progress on goals that span many ticks/sessions: split the work into recorded units, keep progress in durable tasks and memory, and resume after a restart.',
  instructions: `You can work on goals that cannot be finished in one tick/session: they have several steps, or they need ongoing monitoring. Your conversation memory may be incomplete or lost between ticks (a runtime restart clears it completely), so durable state is the only thing you can trust to carry your progress. Re-read durable state instead of relying on what you think you remember. Work in small, finished, recorded units.

Pick a short campaign name (lowercase, no spaces) for the goal, unless the goal gives one, and use it in every key and task title below as <campaign>.

STORAGE (what survives)
- Tasks and memory are durable. Workspace files are NOT durable across restarts: use them only as scratch or cache, and be ready to re-fetch.
- Work-unit queue = tasks. Each unit is one task titled "[<campaign>] <NN> <short description>", where NN is a zero-padded order number.
- Campaign state = memory key \`ltt/<campaign>/index\`. Keep it small: { cycle, phase, unitsTotal, unitsDone, currentUnit, lastSummary, updatedAt }.
- Records (one per entity you track) = one memory key each: \`ltt/<campaign>/rec/<id>\`. Do not store all records under a single key.
- Load all records into context only in the finish step.
- Use \`set_memory\` to write and \`get_memory\` to read these keys.
START OF EVERY TICK (orient before acting)
Do steps 1 and 2 first on every tick, even if the tick message tells you what to do and even if you believe you remember the state.
1. \`get_memory\` \`ltt/<campaign>/index\`.
2. \`list_tasks\` (pending). Task ids come only from this result, never from memory or guesswork. Copy the id exactly.
3. If no index exists, this is a new campaign: do PLAN once, then continue with step 5.
4. If the index phase is \`finished\` and no tasks are pending, there is nothing to do. Do not message the user and end the tick.
5. If \`currentUnit\` is set and its task is still pending, a previous tick was interrupted. Check what was already persisted for that unit (\`get_memory\` on its record key), finish only the missing part, then close it.
6. Otherwise take the lowest-numbered pending unit.

PLAN (once per cycle)
- Break the goal into units that each fit in one tick. Prefer many small units over a few large ones. If the goal already lists the units, use them exactly as listed.
- Write the index first, with \`phase: "planning"\`, so an interrupted plan can be detected on the next tick.
- Create one task per unit, in order. Put the finishing work (re-check, report) in the last unit or in the finish step.
- Set \`phase: "running"\` in the index, then call \`send_message\` with a short plan (number of units, what the first ones are).
- Planning does not count as a unit. After planning, go straight on to the first unit in the same tick, within the per-tick limit below.

DO A UNIT
- Work on one unit only. Stay inside its scope and tool-call budget. If you find something outside the scope, create a new task for it instead of doing it now. Follow the unit's instructions literally; do not substitute something else for a step you were told to do.
- Follow this sequence for every unit:
  1. Update the index: set \`currentUnit\` to the unit number.
  2. Do the unit's work.
  3. Persist each result the moment you have it; do not hold results in your head.
  4. \`complete_task\` with the id from \`list_tasks\`.
  5. Update the index: increment \`unitsDone\`, set \`lastSummary\` (one line), set \`currentUnit\` to null.
  Do step 5 after step 4, and step 4 after step 3.
- A unit is done when there is evidence: records written, or an explicit "nothing found" with the queries or sources you actually checked.
- A unit is blocked if the first result cannot be opened (error, timeout, no access) or returns no readable content (empty text, video-only, or a login or error page). A blocked unit gets no rating.
- If a unit is blocked, store the reason in memory under \`ltt/<campaign>/blocked/<NN>\`, then complete its task so the queue advances (steps 4 and 5). List blocked units in the final report.

CONTINUE
- Respect the per-tick unit limit given in the goal. If none is given, do up to 3 units per tick if each finishes cleanly; stop earlier if you have used most of your tick budget.
- If pending units remain, call \`schedule_reminder\` before ending the tick, using exactly this shape (replace the placeholders, and use the delay given in the goal, otherwise a few minutes):
  \`schedule_reminder({ key: "ltt-<campaign>-continue", message: "<campaign>: resume from ltt/<campaign>/index and do the next pending unit", triggerAt: "<now + delay, ISO 8601 UTC>" })\`
- Use that key and no other. Scheduling again with the same key replaces the earlier reminder.
- End every tick that leaves pending units with a continuation scheduled.
- Once the per-tick limit is reached, stop instead of starting the next unit.

FINISH A CYCLE
- When no pending units remain, first read every stored record back with \`get_memory\`. Build the final report only from what you just read, not from memory of the conversation.
- Send the report with \`send_message\`, and \`publish_artifact\` too if it is substantial.
- Only after the report is sent, set the index phase to \`finished\`. If the phase is \`running\` on a later tick with no pending tasks, the report was not sent: send it.
- The reminder that started this tick has already fired, so do not cancel anything.
- For recurring goals, schedule the next cycle with \`schedule_reminder\` (stable key, \`repeatEveryMinutes\`). At the start of the next cycle, increment \`cycle\` in the index and create a new set of tasks. Keep existing records: update and re-verify them instead of rediscovering. For non-recurring goals, do not schedule anything further.
- Tell the user the cycle is finished and, if recurring, when the next one starts.

RULES
- Do not redo a completed unit. After a restart or with an empty context, rebuild from the index and tasks instead of starting from scratch.
- Do not mark progress you did not make, and do not report something as verified without evidence.
- Keep every memory value compact (facts and short evidence excerpts, not page dumps).
- If you are blocked on something only the user can provide, send a message saying exactly what you need, and keep working on the other units.
- Send a brief progress message to the user every few units (done/total, notable findings), not on every tick. Do this except explicitly instructed otherwise.`,
  requiredTools: ['write_file', 'read_file', 'list_files', 'delete_file', 'stat_file'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 min — units are small and chained by reminders
  visibility: 'public',
  promptHint: 'Describe a multi-step or ongoing goal and what counts as one unit of work (e.g., "Check various sites for latest flight deals from Lagos to Atlanta for 1 person in March 2027. Each site is a unit of work").',
};

/**
 * Preset → skill ID mapping.
 * When a user selects a preset in the UI, this is what gets stored as skillIds.
 */
// Phase 4 (D21): the trading presets now assign the external skills.sh refs
// (D11), not the deleted built-in trading skill ids. The API records the
// assignment only; the install at the agent's first start fills in name /
// description from the frontmatter (T6).
export const SKILL_PRESET_MAP: Record<string, string[]> = {
  trading: ['traderton/skills/crypto-trading', 'traderton/skills/crypto-bot-management'],
  'direct-trading': ['traderton/skills/crypto-trading'],
  'trading-assistant': ['traderton/skills/crypto-trading'],
  'personal-assistant': ['web-access', 'email'],
  custom: [],       // user configures skills manually
};

/** All seeded system skills (excluding base which is auto-injected). */
export const SYSTEM_SKILLS: SkillDefinition[] = [
  PROGRAMMING_SKILL,
  FILE_MANAGEMENT_SKILL,
  WEB_ACCESS_SKILL,
  EMAIL_SKILL,
  PLATFORM_DOCS_SKILL,
  BROWSER_SKILL,
  LONG_RUNNING_TASK_SKILL,
  CHILD_AGENT_MANAGEMENT_SKILL,
];

/**
 * Skills only the user may assign. The agent-side add_skills tool, the broker and the child-create
 * route all refuse these ids. Removal is not restricted.
 */
export const USER_ONLY_SKILL_IDS: ReadonlySet<string> = new Set([CHILD_AGENT_MANAGEMENT_SKILL_ID]);

/** Whether a skill id, or a system slug, is assignable only by the user. */
export function isUserOnlySkill(skillIdOrSlug: string): boolean {
  if (USER_ONLY_SKILL_IDS.has(skillIdOrSlug)) return true;
  return SYSTEM_SKILLS.some((skill) => skill.slug === skillIdOrSlug && USER_ONLY_SKILL_IDS.has(skill.id));
}

/**
 * Map from system skill slug → skill ID for fast lookup.
 *
 * Excludes `BASE_SKILL` — it is auto-injected at runtime and never the
 * target of `add_skills`/`remove_skills`.
 */
export const SYSTEM_SKILL_SLUGS: ReadonlyMap<string, string> = new Map(
  SYSTEM_SKILLS
    .filter((s): s is SkillDefinition & { slug: string } => s.slug != null)
    .map(s => [s.slug, s.id]),
);


// ── Read-time dependency inference ──────────────────────────────────────────

/**
 * Explicit canonical owner for tools that appear in multiple skills.
 * Exported for testability.
 */
// Phase 4 (D21/EC-3): every prior override mapped a trading tool to the deleted
// `trading` built-in skill. With the built-in trading skills gone, there are no
// cross-skill tool-ownership overrides among the remaining system skills. The
// mechanism (consumed by inferDependsOn) stays; the map is empty.
export const TOOL_OWNER_OVERRIDES: Readonly<Record<string, string>> = {};

const baseToolSet = new Set(BASE_SKILL.requiredTools);

let cachedOwnershipMap: ReadonlyMap<string, string> | undefined;

/**
 * Builds (and caches) a map from tool name → canonical owner skill ID.
 *
 * Rules:
 * 1. BASE_SKILL tools are excluded — they are universal and not "owned".
 * 2. Explicit overrides in TOOL_OWNER_OVERRIDES take precedence.
 * 3. For non-overridden tools, the first skill in SYSTEM_SKILLS that lists
 *    the tool wins.
 */
export function buildToolOwnershipMap(): ReadonlyMap<string, string> {
  if (cachedOwnershipMap) return cachedOwnershipMap;

  const map = new Map<string, string>();

  for (const skill of SYSTEM_SKILLS) {
    for (const tool of skill.requiredTools) {
      if (baseToolSet.has(tool)) continue;
      if (map.has(tool)) continue;
      map.set(tool, skill.id);
    }
  }

  // Apply explicit overrides — they win over first-seen order.
  for (const [tool, owner] of Object.entries(TOOL_OWNER_OVERRIDES)) {
    if (!baseToolSet.has(tool)) {
      map.set(tool, owner);
    }
  }

  cachedOwnershipMap = map;
  return cachedOwnershipMap;
}

/**
 * Derives the list of skill IDs that a given skill depends on, based on
 * which skills canonically own the tools it requires.
 *
 * - BASE_SKILL tools are excluded (universal).
 * - The skill itself is excluded.
 * - Returns a deduplicated, sorted array.
 */
export function inferDependsOn(requiredTools: string[], selfSkillId: string): string[] {
  const ownershipMap = buildToolOwnershipMap();
  const deps = new Set<string>();

  for (const tool of requiredTools) {
    if (baseToolSet.has(tool)) continue;
    const owner = ownershipMap.get(tool);
    if (owner && owner !== selfSkillId) {
      deps.add(owner);
    }
  }

  return [...deps].sort();
}
