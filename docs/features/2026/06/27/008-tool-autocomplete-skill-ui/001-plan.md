# Plan: Tool Autocomplete & Discovery in Skill Creation UI

**Status:** draft  
**Created:** 2026-06-27  
**Feature ID:** 008-tool-autocomplete-skill-ui

## Problem

When creating or editing skills via the UI, users must specify which agent tools the skill grants access to (`requiredTools`). Today:

- The `requiredTools` field exists in the API schema (`CreateSkillSchema`, `UpdateSkillSchema`) but has **zero UI surface** — it can only be populated via direct API calls.
- There is no discoverable list of the 46 available agent tools anywhere in the UI or API.
- Users must magically know tool names like `submit_decision`, `check_regime`, or `resolve_watch` — and type them in manually with no validation until the API rejects unknown names.
- The `KNOWN_AGENT_TOOL_NAMES` constant in `packages/domain/src/tools.ts` is the canonical source of truth but is only consumed at worker startup for drift checks — the API and web layers never read it.

This means the skill authoring experience is incomplete: users can write instructions and set visibility, but can't actually wire up the tools those instructions reference.

## Goal

Provide a discoverable, validated tool selection experience in the skill creation and edit UI:

1. **API**: A read-only `GET /api/v1/agent-tools` endpoint that surfaces all 46 tools with their names, categories, and descriptions.
2. **UI**: A tag-picker (combobox-style multi-select) component that lets users search, browse by category, and select tools with validation built in.
3. **Polish**: Tools grouped by category for scannability; selected tools displayed as removable pills.

## Out of Scope

- Inline `#` autocomplete in the Instructions textarea (deferred as V2 enhancement).
- Editing `capabilityFamilies`, `contextRequirements`, or `requiredGuardrails` in the UI (these arrays share the same gap but are separate features).
- Agent-level tool filtering (hide unavailable tools per plan/capability) — that's a runtime concern already handled by `apps/worker/src/runtime-tool-visibility.ts`.

## Design Decisions

### 1. Tool catalog lives in domain, not the worker

The worker already has per-tool metadata (name, category, description) scattered across 16 files in `apps/worker/src/tools/`. Extracting that into a static catalog in `packages/domain/src/tools.ts`:

- Makes it available to the API without importing the worker (which would create a forbidden dependency — domain → worker would invert the dependency direction).
- Gives the worker a single source of truth to validate against (replacing the current `assertToolCatalogMatchesRegistry` drift check with a catalog-based check).
- Follows the existing pattern: `KNOWN_AGENT_TOOL_NAMES` already lives in domain; the catalog enriches it with category + description.

**Structure:**

```ts
// packages/domain/src/tools.ts — new export
export const TOOL_CATALOG: Record<string, { category: ToolCategory; description: string }> = {
  submit_decision:    { category: 'execute-trade',       description: 'Submit a trade decision for a specific instrument...' },
  search_tokens:      { category: 'read-market-data',    description: 'Search for tokens by name/symbol on DEX aggregators...' },
  // ... all 46 tools
};
```

The worker's `assertToolCatalogMatchesRegistry()` is updated to cross-reference the catalog instead of the flat name list, catching drift in both directions (tool in catalog but missing implementation, and vice versa).

### 2. API endpoint follows the `tool-schemas` discovery pattern

`GET /api/v1/agent-tools` — no DB dependency, reads from the static `TOOL_CATALOG`. Supports optional `?category=` filter. Pattern identical to `GET /api/v1/tool-schemas` and `GET /api/v1/strategy-schemas`.

Response shape:

```json
{
  "ok": true,
  "tools": [
    { "name": "submit_decision", "category": "execute-trade", "description": "Submit a trade decision..." },
    { "name": "search_tokens", "category": "read-market-data", "description": "Search for tokens..." }
  ],
  "categories": [
    { "name": "execute-trade", "label": "Trade Execution", "count": 2 },
    { "name": "read-market-data", "label": "Market Data (Read)", "count": 6 }
  ]
}
```

Including `categories` in the response avoids the UI needing to derive them client-side and gives us a place to add human-readable labels later.

### 3. UI component: `ToolTagPicker` — combobox with category sections

A new shared component in `apps/web/src/lib/ui.tsx` (alongside `Button`, `Card`, etc.):

- **Closed state**: Shows selected tools as removable pills. "Add tools..." trigger button.
- **Open state**: A search input at the top. Below it, a scrollable list grouped by category. Each tool shows its name + description. Selected tools have a checkmark + highlighted background.
- **Filtering**: Typing in the search input filters tools by name or description substring match.
- **Selection**: Click a tool to toggle it. Press Escape to close. Click outside to close.
- **Props**: `value: string[]`, `onChange: (tools: string[]) => void`, `tools: ToolInfo[]` (fetched from API), `disabled?: boolean`.

This is a net-new component — no combobox or tag-input exists in the codebase today. The closest analog is `SkillPicker` (a checkbox list), which we use as a style reference for the list items.

### 4. Form placement

In both the create composer and the inline edit form inside `SkillCard`, the tool picker is added as a new `<label>` block between **Instructions** and **Visibility**. This keeps the logical flow: "What does this skill do?" → "What tools does it use?" → "Who can see it?"

### 5. No new dependencies

The web UI currently uses zero third-party component libraries — all UI is built on plain React with inline styles. We maintain that constraint. The `ToolTagPicker` uses native `<input>`, `<Popover>`-style absolute positioning, and keyboard event handlers — no `downshift`, `radix-ui`, or `headlessui` needed.

---

## Implementation Plan

### Phase 1: Domain — Tool Catalog

**Goal:** Add `TOOL_CATALOG` to `packages/domain/src/tools.ts` with all 46 tools, their categories, and descriptions. Export it. Update the worker's drift check.

**Files:**

| File | Change |
|---|---|
| `packages/domain/src/tools.ts` | Add `TOOL_CATALOG` constant (lines after `KNOWN_AGENT_TOOL_NAMES`). Each entry: `{ category: ToolCategory; description: string }`. Descriptions sourced from existing `AgentTool.description` fields in the worker's tool files. |
| `packages/domain/src/tools.ts` | Add `ToolCatalogEntry` type export and `getToolCatalogEntry(name: string)` helper. |
| `apps/worker/src/tools/index.ts` | Update `assertToolCatalogMatchesRegistry()` to cross-reference `TOOL_CATALOG` keys instead of `KNOWN_AGENT_TOOL_NAMES`. Verify category consistency between catalog and registered `AgentTool.category`. |

**Catalog population strategy:** Read each tool file in `apps/worker/src/tools/` and copy the `description` string from the `AgentTool` definition. Categories are already aligned — the catalog's `category` field must match the tool's `AgentTool.category` exactly. The drift check in `index.ts` enforces this at startup.

**Tool catalog — all 46 entries:**

```
execute-trade (2):      submit_decision, create_bot
read-database (8):      get_analytics, list_positions, list_bots, get_bot_status,
                        get_account_summary, get_risk_limits, find_instrument,
                        resolve_bot
write-database (4):     stop_bot, start_bot, adjust_bot_config, adjust_risk_limits
read-market-data (6):   search_tokens, discover_tokens, check_regime,
                        get_funding_rates, get_market_overview, get_price
read-web (3):           search_web, browse_url, read_document
read-config (1):        get_schema
read-memory (6):        get_memory, list_memory_keys, list_tasks, list_watches,
                        resolve_watch, resolve_task
write-memory (8):       set_memory, delete_memory, create_task, complete_task,
                        schedule_reminder, watch_token, remove_watch, check_watches
write-messaging (2):    send_message, publish_artifact
read-filesystem (3):    read_file, list_files, stat_file
write-filesystem (2):   write_file, delete_file
execute-filesystem (1): execute_code
```

**Tests:**
- `TOOL_CATALOG` has exactly 46 entries, matching `KNOWN_AGENT_TOOL_NAMES` length.
- Every key in `TOOL_CATALOG` appears in `KNOWN_AGENT_TOOL_NAMES` and vice versa.
- `getToolCatalogEntry('submit_decision')` returns the correct entry; `getToolCatalogEntry('nonexistent')` returns `undefined`.

---

### Phase 2: API — `GET /api/v1/agent-tools` Endpoint

**Goal:** Expose the tool catalog via a read-only discovery endpoint. Wire into the API router.

**Files:**

| File | Change |
|---|---|
| `apps/api/src/routes/agent-tools.ts` | **New file.** Route factory: `export async function agentToolsRoutes(app: FastifyInstance): Promise<void>`. Single `GET /api/v1/agent-tools` handler. |
| `apps/api/src/index.ts` | Import and call `await agentToolsRoutes(app)` in the discovery endpoints block (near `toolSchemaRoutes`, line ~150). |
| `apps/api/src/routes/agent-tools.test.ts` | **New file.** Test: returns 200 with all 46 tools. Test: `?category=execute-trade` filters correctly. Test: unknown category returns empty list (not 404 — it's a filter, not a lookup). |

**Route handler pattern (modeled on `tool-schemas.ts`):**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOOL_CATALOG, TOOL_CATEGORY_LABELS } from '@herobids/domain';

const AgentToolsQuerySchema = z.object({
  category: z.string().optional(),
});

export async function agentToolsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/agent-tools', async (request, reply) => {
    const query = AgentToolsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid_query',
        details: query.error.issues,
      });
    }

    const { category } = query.data;

    let tools = Object.entries(TOOL_CATALOG).map(([name, entry]) => ({
      name,
      category: entry.category,
      description: entry.description,
    }));

    if (category) {
      tools = tools.filter((t) => t.category === category);
    }

    // Derive category summary from the full catalog (unfiltered)
    const categoryCounts = new Map<string, number>();
    for (const entry of Object.values(TOOL_CATALOG)) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    }
    const categories = Array.from(categoryCounts.entries()).map(([name, count]) => ({
      name,
      label: TOOL_CATEGORY_LABELS[name] ?? name,
      count,
    }));

    return reply.send({ ok: true, tools, categories });
  });
}
```

**Auth:** No special treatment needed — the JWT auth plugin already guards all `/api/v1/*` routes. The endpoint is read-only and returns static data, so any authenticated user can call it.

**Tests:**
- `GET /api/v1/agent-tools` → 200, `tools` array has 46 items, `categories` array has 12 items.
- `GET /api/v1/agent-tools?category=execute-trade` → 200, `tools` has 2 items (`submit_decision`, `create_bot`).
- `GET /api/v1/agent-tools?category=nonexistent` → 200, `tools` is empty array, `categories` still has all 12.
- Response matches `ToolCatalogEntry` shape: each tool has `name`, `category`, `description`.

---

### Phase 3: Web UI — `ToolTagPicker` Component + Form Integration

**Goal:** Build a reusable `ToolTagPicker` combobox component. Integrate it into the skill create and edit forms. Wire the API client.

**Files:**

| File | Change |
|---|---|
| `apps/web/src/lib/ui.tsx` | Add `ToolTagPicker` component export. |
| `apps/web/src/lib/api-client.ts` | Add `agentTools.list(params?)` API method and `AgentToolInfo` interface. |
| `apps/web/src/features/skills/SkillsPage.tsx` | Add `ToolTagPicker` to create composer (after Instructions, before Visibility). Add `requiredTools` to `createDraft` state. Pass `requiredTools` in `createMutation`. |
| `apps/web/src/features/skills/SkillsPage.tsx` | Add `ToolTagPicker` to `SkillCard` inline edit form. Add `editedRequiredTools` state. Pass `requiredTools` in `updateMutation`. |

#### 3a. API Client (`apps/web/src/lib/api-client.ts`)

```ts
export interface AgentToolInfo {
  name: string;
  category: string;
  description: string;
}

export interface AgentToolCategory {
  name: string;
  label: string;
  count: number;
}

export const agentTools = {
  list: (params?: { category?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.category) searchParams.set('category', params.category);
    const query = searchParams.toString();
    return request<{ ok: true; tools: AgentToolInfo[]; categories: AgentToolCategory[] }>(
      `/api/v1/agent-tools${query ? `?${query}` : ''}`,
    );
  },
};
```

#### 3b. `ToolTagPicker` Component Design

**Props:**
```ts
interface ToolTagPickerProps {
  tools: AgentToolInfo[];           // full tool list from API
  categories: AgentToolCategory[];  // category summary from API
  value: string[];                  // selected tool names
  onChange: (tools: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
}
```

**States:**
- **Loading**: Show skeleton placeholders (3 pill-shaped grey blocks).
- **Empty (no tools data)**: Show muted text "No tools available."
- **Normal**: Renders selected pills + "Add tools..." trigger.
- **Open**: Search input focused, dropdown visible with category-grouped list.

**Internal state:**
- `isOpen: boolean` — dropdown visibility
- `searchQuery: string` — filters the visible tool list

**Rendering (closed):**
```
[submit_decision ×] [search_tokens ×] [get_price ×]  [+ Add tools...]
```
Each pill is a `<span>` with `pillStyle` (already defined in `SkillsPage.tsx`). The `×` button removes the tool from selection. The "Add tools..." button opens the dropdown.

**Rendering (open):**
```
┌─────────────────────────────────────────┐
│ 🔍 Search tools...                       │
├─────────────────────────────────────────┤
│ Trade Execution (2)                      │
│   ✓ submit_decision                      │
│     Submit a trade decision for a...     │
│   ○ create_bot                           │
│     Create and start a new trading...    │
├─────────────────────────────────────────┤
│ Market Data — Read (6)                   │
│   ✓ search_tokens                        │
│     Search for tokens by name/symbol...  │
│   ○ check_regime                         │
│     Evaluate market regime using...      │
│   ○ get_market_overview                  │
│     Aggregated market overview...        │
│   ...                                    │
└─────────────────────────────────────────┘
```

**Behaviors:**
- Clicking a tool toggles selection (adds/removes from `value`).
- Pressing Escape or clicking outside closes the dropdown.
- The search input filters tools in real-time — matching against both `name` and `description`. Categories with zero visible tools after filtering are hidden.
- Keyboard: Arrow keys navigate the list; Enter toggles the highlighted item.
- `onChange` is called with a new sorted array (stable sort by category order, then alphabetical within category).

**Style:** Uses the same CSS custom properties as the rest of the UI kit (`var(--color-surface-1)`, `var(--color-border)`, `var(--color-accent)`, etc.). The dropdown uses `position: absolute` with a portal or high z-index to float over other form content.

#### 3c. Form Integration — Create Composer

In `SkillsPage.tsx`:

1. Add `requiredTools` to the `createDraft` initial state:
   ```ts
   const [createDraft, setCreateDraft] = useState<CreateSkillRequest>({
     name: '',
     description: '',
     instructions: '',
     requiredTools: [],        // NEW
     publicationStatus: 'draft',
   });
   ```

2. Add a `useQuery` for the tools list:
   ```ts
   const toolsQuery = useQuery({
     queryKey: ['agent-tools'],
     queryFn: () => agentTools.list(),
     staleTime: 5 * 60 * 1000, // cache for 5 min — tool list rarely changes
   });
   ```

3. Insert the picker after Instructions:
   ```tsx
   <label style={fieldLabelStyle}>
     Tools
     <ToolTagPicker
       tools={toolsQuery.data?.tools ?? []}
       categories={toolsQuery.data?.categories ?? []}
       value={createDraft.requiredTools ?? []}
       onChange={(tools) => setCreateDraft((current) => ({ ...current, requiredTools: tools }))}
       loading={toolsQuery.isLoading}
     />
   </label>
   ```

4. The create mutation already sends `requiredTools` — no API change needed since `CreateSkillRequest` already includes it.

#### 3d. Form Integration — Edit Form (SkillCard)

In the `SkillCard` component within `SkillsPage.tsx`:

1. Add `editedRequiredTools` state, initialized from `skill.requiredTools`:
   ```ts
   const [editedRequiredTools, setEditedRequiredTools] = useState<string[]>(skill.requiredTools ?? []);
   ```

2. Insert the picker after the Instructions textarea:
   ```tsx
   <label style={fieldLabelStyle}>
     Tools
     <ToolTagPicker
       tools={toolsQuery.data?.tools ?? []}
       categories={toolsQuery.data?.categories ?? []}
       value={editedRequiredTools}
       onChange={setEditedRequiredTools}
       loading={toolsQuery.isLoading}
     />
   </label>
   ```

3. Include `requiredTools` in the update mutation payload:
   ```ts
   const updateMutation = useMutation({
     mutationFn: () => skillsApi.update(skill.id, {
       name: editedName.trim(),
       description: editedDescription.trim(),
       instructions: editedInstructions.trim(),
       requiredTools: editedRequiredTools,   // NEW
       changeSummary: 'Updated from web editor',
     }),
     // ...
   });
   ```

4. Reset `editedRequiredTools` when `isEditing` transitions to `true` (in the Edit button handler), reading from `skill.requiredTools`.

5. **Fallback for existing skills:** Skills created via API without `requiredTools` will have `skill.requiredTools` as `undefined` or `[]`. The picker gracefully handles an empty array — no pills shown, "Add tools..." trigger ready.

---

### Phase 4: Validation & Edge Cases

**Goal:** Ensure the tool picker provides good UX across edge cases and the API validation still catches unknown tools.

**Files:**

| File | Change |
|---|---|
| `apps/api/src/routes/skills.ts` | The existing `buildUnknownToolValidationError()` already validates `requiredTools` against `KNOWN_AGENT_TOOL_NAMES` via `findUnknownSkillTools()`. No change needed — the tag picker prevents typos, but the server-side validation is the safety net. |
| `apps/web/src/features/skills/SkillsPage.tsx` | Handle `toolsQuery` error state: show `ErrorBanner` inside the picker area. |

**Edge cases covered:**
- **Empty tools list**: Picker shows "Add tools..." trigger; clicking it opens an empty dropdown with "No tools match your search."
- **All tools selected**: The "Add tools..." button still works — user can deselect.
- **Rapid toggle**: `onChange` is called per-tool; React batches state updates.
- **Skill with 20+ tools**: The pills wrap to multiple lines. The dropdown scrolls (max-height ~320px).
- **API returns 500**: The `toolsQuery.error` state renders an `ErrorBanner` inside the field label area. User can still create the skill without tools (the field is optional).
- **Search with no results**: Dropdown shows "No tools match 'xyz'." Category headers hidden.

---

## Test Plan

### Unit Tests

| Layer | Test | File |
|-------|------|------|
| Domain | `TOOL_CATALOG` has 46 entries, matches `KNOWN_AGENT_TOOL_NAMES` | `packages/domain/src/tools.test.ts` |
| Domain | `getToolCatalogEntry()` returns correct entry / undefined | `packages/domain/src/tools.test.ts` |
| API | `GET /api/v1/agent-tools` returns 200 with 46 tools | `apps/api/src/routes/agent-tools.test.ts` |
| API | `?category=execute-trade` filters to 2 tools | `apps/api/src/routes/agent-tools.test.ts` |
| API | `?category=nonexistent` returns empty tools, full categories | `apps/api/src/routes/agent-tools.test.ts` |
| Worker | `assertToolCatalogMatchesRegistry()` passes with catalog | `apps/worker/src/tools/index.test.ts` |

### Integration / E2E Tests

| Test | File |
|-------|------|
| Create skill via API with `requiredTools: ['submit_decision', 'get_price']` → 200, persisted correctly | Existing skills CRUD test |
| Create skill via API with unknown tool → 400 with `skills.unknown_required_tools` | Existing skills CRUD test (already covered) |

### UAT Cases (browser)

| ID | Scenario |
|----|----------|
| SK-T01 | Open create composer → Tools field visible between Instructions and Visibility |
| SK-T02 | Click "Add tools..." → dropdown opens, all 46 tools visible grouped by category |
| SK-T03 | Type "search" in search input → list filters to `search_tokens`, `search_web` |
| SK-T04 | Click `search_tokens` → pill appears in closed view, checkmark in dropdown |
| SK-T05 | Click `search_tokens` again (or × on pill) → tool removed from selection |
| SK-T06 | Select 3 tools across different categories → all 3 pills visible, all 3 checked in dropdown |
| SK-T07 | Press Escape → dropdown closes, selection preserved |
| SK-T08 | Click outside dropdown → dropdown closes, selection preserved |
| SK-T09 | Create skill with 2 tools → skill appears in list, edit shows tools pre-selected |
| SK-T10 | Edit skill, add a tool, save → skill updated, reopen edit → new tool still selected |
| SK-T11 | Edit skill, remove all tools, save → skill has empty requiredTools |
| SK-T12 | Tools query fails (network error) → ErrorBanner shown, form still submittable |

---

## Dependencies & Risks

| Dependency | Status |
|---|---|
| `KNOWN_AGENT_TOOL_NAMES` in domain | Already exists and exported |
| `ToolCategory` type in domain | Already exists and exported |
| Worker tool descriptions | Exist in 16 tool files — need extraction into catalog |
| `CreateSkillRequest.requiredTools` | Already in API schema and web API client |
| `UpdateSkillRequest.requiredTools` | Already in API schema and web API client |
| `findUnknownSkillTools()` validation | Already in skills route — no change needed |

**Risks:**
- **Tool catalog drift**: If a new tool is added to the worker but not the catalog, the API won't show it. Mitigated by the updated `assertToolCatalogMatchesRegistry()` drift check at worker startup — it will fail loudly.
- **Category label maintenance**: The `CATEGORY_LABELS` mapping in the API route is a second place that needs updating if categories change. Low risk — categories change very rarely (last change was months ago). Could be moved to domain later if it becomes a problem.

---

## Rollout

1. Merge domain + worker drift check changes (Phase 1).
2. Merge API endpoint (Phase 2).
3. Merge UI component + form integration (Phase 3).
4. No migration needed. No config changes needed.
5. Backward compatible: `requiredTools` is optional on both create and update; existing skills without tools are unaffected.

---

## Outstanding Issues (post-implementation review)

### Phase 1 — Domain Tool Catalog

**LOW:**
- **Redundant KNOWN_AGENT_TOOL_NAMES check**: `assertToolCatalogMatchesRegistry()` performs both `KNOWN_AGENT_TOOL_NAMES` ↔ registry and `TOOL_CATALOG` ↔ registry checks. Redundant but safe. Consider making `TOOL_CATALOG` the single canonical source.
- **Test coverage**: `tools.test.ts` only tests `submit_decision` happy path. Could add parameterized test iterating all 46 entries.

### Phase 2 — API Endpoint

**LOW:**
- **Missing ToolCategory type import**: Route only imports `TOOL_CATALOG`, not the `ToolCategory` type. Cosmetic.
- **No 400 test**: Zod schema uses `z.string().optional()` so there's no real 400 case today.
- **Filter test shape validation**: Category filter test doesn't re-validate shape of each filtered tool. Covered by unfiltered test.

### Phase 3 — Web UI

**MEDIUM (deferred):**
- **Keyboard navigation not implemented**: Arrow keys + Enter to navigate/select tools in the dropdown. Plan specified this; accessibility gap.
- **Hardcoded English strings**: ToolTagPicker hardcodes strings instead of using react-intl. Should accept labels as props or use useIntl().

**LOW:**
- `selectedSet` recreated every render (negligible for 46 items).
- Redundant Escape key handling in both useEffect and onKeyDown.
- Dropdown maxHeight 360px vs plan's ~320px.
- "No tools available" shown misleadingly during API error states.
- Event handler uses `e` instead of `event` naming convention.
