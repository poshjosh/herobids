import type { AgentFormState } from './agent-form-state.js';
import type { AgentStyleValue, RuntimePolicyOverrides } from './style-mapping.js';
import type { SkillPresetId } from './agent-display.js';

// ---------------------------------------------------------------------------
// OAuth draft storage for the edit-agent flow
//
// When the user clicks "Add Connection" in the edit-agent modal and picks an
// OAuth-only provider (e.g. Gmail), the browser redirects away for
// authorization.  We persist the current edit state to sessionStorage so it
// can be restored when the browser redirects back, preserving any unsaved
// edits the user made before starting the OAuth flow.
// ---------------------------------------------------------------------------

const EDIT_AGENT_OAUTH_DRAFT_KEY = 'edit-agent-oauth-draft-v1';

export interface EditAgentOAuthDraft {
  agentId: string;
  /** Full form state, excluding non-serializable pendingFiles. */
  form: Omit<AgentFormState, 'pendingFiles'>;
  style: AgentStyleValue;
  skillPreset: SkillPresetId;
  modelOverrideEnabled: boolean;
  modelForm: { provider: string; lightModel: string; heavyModel: string };
  runtimePolicyOverrides: RuntimePolicyOverrides | null;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export function saveEditAgentOAuthDraft(draft: EditAgentOAuthDraft): void {
  try {
    window.sessionStorage.setItem(EDIT_AGENT_OAUTH_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage failures; OAuth return will still fall back to reopening the form.
  }
}

export function loadEditAgentOAuthDraft(): EditAgentOAuthDraft | null {
  try {
    const raw = window.sessionStorage.getItem(EDIT_AGENT_OAUTH_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditAgentOAuthDraft;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.agentId !== 'string') return null;
    // Basic structural check — form must have at least the core fields
    if (!parsed.form || typeof parsed.form !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearEditAgentOAuthDraft(): void {
  try {
    window.sessionStorage.removeItem(EDIT_AGENT_OAUTH_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

// ---------------------------------------------------------------------------
// Pure restoration logic (testable without sessionStorage / window)
// ---------------------------------------------------------------------------

export interface OAuthReturnRestoreResult {
  form: AgentFormState;
  style: AgentStyleValue;
  skillPreset: SkillPresetId;
  modelOverrideEnabled: boolean;
  modelForm: { provider: string; lightModel: string; heavyModel: string };
  runtimePolicyOverrides: RuntimePolicyOverrides | null;
}

/**
 * Computes the restored edit-modal state from an OAuth return.
 *
 * Returns `null` when the draft is missing or belongs to a different agent,
 * signalling the caller should leave the form untouched.
 *
 * The returned `form.pendingFiles` is always an empty array — file upload
 * state cannot survive a full-page OAuth redirect.
 */
export function applyOAuthReturnToForm(
  currentForm: AgentFormState,
  draft: EditAgentOAuthDraft | null,
  connectionId: string | null,
  agentId: string,
): OAuthReturnRestoreResult | null {
  if (!draft || draft.agentId !== agentId) return null;

  const mergedConnectionIds = connectionId
    ? Array.from(new Set([...(draft.form.connectionIds ?? []), connectionId]))
    : (draft.form.connectionIds ?? []);

  return {
    form: {
      ...draft.form,
      connectionIds: mergedConnectionIds,
      pendingFiles: currentForm.pendingFiles, // preserve any in-memory pending files (typically [])
    },
    style: draft.style,
    skillPreset: draft.skillPreset,
    modelOverrideEnabled: draft.modelOverrideEnabled,
    modelForm: draft.modelForm,
    runtimePolicyOverrides: draft.runtimePolicyOverrides,
  };
}
