/**
 * Guided Setup OAuth resume draft.
 *
 * Mirrors the proven create-agent OAuth draft pattern in
 * `apps/web/src/features/agents/AgentsPage.tsx`, but stores the thread/action
 * context needed to resume a Guided Setup conversation after an OAuth redirect
 * (e.g. Gmail) instead of form state.
 */

export interface GuidedSetupOAuthDraft {
  threadId: string;
  actionId: string;
}

const GUIDED_SETUP_OAUTH_DRAFT_KEY = 'guided-setup-oauth-draft-v1';

export function saveGuidedSetupOAuthDraft(draft: GuidedSetupOAuthDraft): void {
  try {
    window.sessionStorage.setItem(GUIDED_SETUP_OAUTH_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage failures; OAuth return will still fall back to reopening the thread.
  }
}

export function loadGuidedSetupOAuthDraft(): GuidedSetupOAuthDraft | null {
  try {
    const raw = window.sessionStorage.getItem(GUIDED_SETUP_OAUTH_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GuidedSetupOAuthDraft;
    if (!parsed || typeof parsed !== 'object' || !parsed.threadId || !parsed.actionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearGuidedSetupOAuthDraft(): void {
  try {
    window.sessionStorage.removeItem(GUIDED_SETUP_OAUTH_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
}
