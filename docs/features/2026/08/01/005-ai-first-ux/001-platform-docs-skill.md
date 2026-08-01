# Plan: Platform Docs Skill & Tools

**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Draft

## Summary

Add a `platform-docs` skill with three tools (`search_app_docs`, `list_app_docs`, `read_app_docs`) that give LLM agents the ability to read the platform's own documentation, forms, and configuration schemas. This is a prerequisite for the onboarding chat agent — it needs to understand the "Create Agent" form, connection types, venue mappings, and supported presets to guide users conversationally.

## Why a Separate Skill (Not Part of `base`)

- `base` is auto-injected into every agent at runtime — trading agents don't need doc-search context
- The onboarding chat agent carries `platform-docs` as its primary skill
- Other agents can opt-in (e.g., a support agent, a self-configuring agent)
- Keeps the auto-injected context minimal

## Scope

### In Scope

- New `platform-docs` skill definition in `packages/domain/src/skills.ts`
- Three new tools: `search_app_docs`, `list_app_docs`, `read_app_docs`
- Tool registration in `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG`, and `createToolRegistry()`
- Docs index built from:
  - All Markdown pages under `apps/web/src/features/public-pages/content/`
  - `CreateAgentSchema` fields with Zod constraints (extracted from `apps/api/src/routes/agents.ts`)
  - `SKILL_PRESET_MAP` from `packages/domain/src/skills.ts`
  - Venue/chain mapping (`VENUE_TYPE_MAP` from `apps/web/src/features/agents/venue-mapping.ts`)
  - `AgentStyleValue` → defaults mapping (`resolveStyleDefaults` in the frontend, or domain config)
  - Connection types and their requirements
  - UI terminology — canonical display names (preset labels, style labels, mode labels, chain names) so the chat LLM uses the same terms as the UI
  - Agent lifecycle model (pause/resume, execution modes)
- Index generation at build time (generated JSON artifact shipped with the worker)
- `read-config` tool category (consistent with existing `get_schema`)

### Out of Scope

- Real-time docs sync (docs change on deploy, index rebuilds on build)
- Indexing external websites
- Full-text search engine — in-memory substring/prefix matching is sufficient
- Agent- or user-specific docs (all docs are public platform docs)

## Implementation Steps

### Step 1: Define the Docs Index Format

Create a canonical JSON schema for the docs index stored at build time:

```typescript
interface DocsIndexEntry {
  /** Unique path identifier, e.g. "docs/agents/billing-limits" or "schema/CreateAgentSchema" */
  id: string;
  /** Human-readable title */
  title: string;
  /** Content type */
  kind: 'markdown' | 'schema' | 'mapping' | 'faq';
  /** Searchable plaintext content */
  content: string;
  /** Section headings extracted from markdown */
  headings: string[];
  /** Tags for filtering */
  tags: string[];
}

/**
 * Example: UI terminology reference entry.
 * This gives the LLM a single lookup for canonical display names so chat
 * terminology matches the UI (e.g., says "AI crypto trader" not "trading agent").
 */
const EXAMPLE_TERMINOLOGY_ENTRY: DocsIndexEntry = {
  id: 'reference/ui-terminology',
  title: 'UI Terminology Reference',
  kind: 'mapping',
  content: `
When referring to platform concepts in the chat UI, use these exact terms:

Agent presets (what the user is creating):
- "AI crypto trader" — autonomous trading agent (skillPresetId: trading)
- "AI direct trader" — manual-style trading agent (skillPresetId: direct-trading)
- "AI trading assistant" — advisory trading agent (skillPresetId: trading-assistant)
- "AI personal assistant" — task, email, and research agent (skillPresetId: personal-assistant)
- "Custom AI" — user selects skills manually (skillPresetId: custom)

Risk styles (how aggressive the agent is):
- "Careful" — lower risk, smaller positions, tighter stops
- "Balanced" — moderate risk, default settings
- "Bold" — higher risk, larger positions, wider stops

Execution modes:
- "Test mode" — simulated trading, no real money, safe to experiment
- "Live mode" — real trading with real funds

Chains (user-facing; map to venues internally):
- "Ethereum" or "Arbitrum" → Hyperliquid (perpetual futures)
- "Solana" → Jupiter (DEX spot/swaps)
- "Base" → 1inch (DEX spot/swaps)
- "BSC" → 1inch (DEX spot/swaps)
- "Any" → let the platform choose

Connection types:
- "Exchange connection" — for trading venues (Hyperliquid, etc.)
- "Wallet connection" — for DEX trading (Jupiter, 1inch, etc.)
- "Email connection" — for sending email on your behalf (Gmail, Outlook)
`,
  headings: ['Agent presets', 'Risk styles', 'Execution modes', 'Chains', 'Connection types'],
  tags: ['terminology', 'labels', 'ui', 'display-names'],
};
```

### Step 2: Build the Index Generator

Create `scripts/ts/build-docs-index.ts`:

1. Walk `apps/web/src/features/public-pages/content/en/` recursively
2. For each `.md` file: parse frontmatter (title), extract plaintext, extract headings
3. Add hardcoded schema entries for `CreateAgentSchema` (derive from the Zod schema, listing every field with type, constraints, and description)
4. Add hardcoded mapping entries for:
   - `SKILL_PRESET_MAP` (preset → skill IDs)
   - Venue/chain mapping
   - Agent style → defaults
   - Connection types
5. Write `apps/worker/src/tools/platform-docs-index.json` (or a TS file that exports the array)

**Alternative (simpler for v1):** Hardcode the index as a TypeScript module in `apps/worker/src/tools/platform-docs-data.ts`. The content is small enough (~50-100KB of plaintext) that runtime loading is fine. We can add build-time generation later.

### Step 3: Add Tool Names to Domain

In `packages/domain/src/tools.ts`:

1. Add to `KNOWN_AGENT_TOOL_NAMES`:
   ```
   'search_app_docs',
   'list_app_docs',
   'read_app_docs',
   ```

2. Add to `TOOL_CATALOG`:
   ```typescript
   search_app_docs: { category: 'read-config', description: 'Search platform docs, schemas, and mappings. Returns ranked results with excerpts.' },
   list_app_docs:   { category: 'read-config', description: 'List all available documentation pages, schemas, and reference materials.' },
   read_app_docs:   { category: 'read-config', description: 'Read a specific documentation page or schema by its path ID.' },
   ```

### Step 4: Implement the Tools

Create `apps/worker/src/tools/platform-docs.ts`:

```typescript
// Tools: search_app_docs, list_app_docs, read_app_docs

// search_app_docs
// - Input: { query: string, kind?: 'markdown' | 'schema' | 'mapping' | 'faq', maxResults?: number }
// - Does simple case-insensitive substring matching across title + content + headings + tags
// - Returns ranked results (title match > heading match > content match) with excerpts

// list_app_docs
// - Input: { kind?: 'markdown' | 'schema' | 'mapping' | 'faq' }
// - Returns all index entries with id, title, kind, headings, tags (no full content)
// - Used by the LLM to discover what's available before calling read_app_docs

// read_app_docs
// - Input: { id: string }
// - Returns the full content of a single entry
// - The LLM calls this after discovering entries via list_app_docs or search_app_docs
```

Follow the existing tool patterns:
- Use `z.object()` for parameter schemas
- Use `convertZodToJsonSchema` for JSON Schema generation
- Return `ToolResult` with `{ success, data }` or `{ success, error, errorCode }`
- Category: `'read-config'` (same as `get_schema`)

### Step 5: Register Tools in the Registry

In `apps/worker/src/tools/index.ts`:

1. Import `platformDocsTools` from `'./platform-docs.js'`
2. Add to the `allTools` array in `createToolRegistry()`
3. The `assertToolCatalogMatchesRegistry` check ensures consistency

### Step 6: Define the Skill

In `packages/domain/src/skills.ts`:

```typescript
export const PLATFORM_DOCS_SKILL: SkillDefinition = {
  id: 'platform-docs',
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
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
  promptHint: 'Ask me about platform features, agent configuration, or how to get started.',
};
```

Add to `SYSTEM_SKILLS` array.

### Step 7: Seed the Skill

`syncSystemSkills(db)` in `apps/api/src/index.ts` will auto-seed on next restart (per existing `SYSTEM_SKILLS` upsert behavior). Verify the skill appears in the skills table.

### Step 8: Add to SKILL_PRESET_MAP

Do NOT add `platform-docs` to `SKILL_PRESET_MAP` for any existing preset. It will be assigned directly to the onboarding chat agent.

However, the skill is `visibility: 'public'` and will appear in the skill picker for regular agents. Users can manually add it to custom agents. This is intentional — agents that do self-configuration (e.g., adjusting their own risk limits, changing strategy presets) benefit from being able to read platform schemas and docs.

## Docs Index Content Checklist

The index must cover:

- [ ] All pages under `apps/web/src/features/public-pages/content/en/docs/`
- [ ] All pages under `apps/web/src/features/public-pages/content/en/help/`
- [ ] All pages under `apps/web/src/features/public-pages/content/en/legal/`
- [ ] `CreateAgentSchema` — every field with type, constraints, defaults, and description
- [ ] `UpdateAgentSchema` — same level of detail
- [ ] `SKILL_PRESET_MAP` — which skill IDs each preset resolves to
- [ ] Skill descriptions — what each skill provides
- [ ] Venue/chain mapping — "Ethereum" → Hyperliquid, "Solana" → Jupiter, etc.
- [ ] Agent styles — `careful`/`balanced`/`bold` → preset resolution + defaults
- [ ] Connection types — what each connection type enables (trading, email, etc.)
- [ ] UI terminology reference — canonical display names the LLM must use (preset labels, style labels, execution mode labels, venue names) so chat terminology matches the UI
- [ ] Execution modes — `test`/`paper`/`shadow`/`live` semantics
- [ ] Agent lifecycle — pause/resume/stop behavior
- [ ] Billing model overview

## Verification

- `pnpm lint` passes
- Worker starts without tool catalog mismatch errors
- Skill appears in `GET /skills` response
- Manual test: create an agent with `platform-docs` skill, verify it can call the tools

## Risks

| Risk | Mitigation |
|------|-----------|
| Docs index gets stale vs actual frontend pages | Regenerate on build; CI check that index is up to date |
| Schema field docs diverge from actual Zod validation | Include a CI check or test that verifies schema docs coverage |
| Large content exhausts LLM context window | `list_app_docs` returns summaries only; `read_app_docs` returns one doc at a time; `search_app_docs` returns excerpts |
