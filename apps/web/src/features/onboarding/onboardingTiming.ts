/**
 * Timing for the onboarding chat shown while a new agent is created.
 * The chat only takes over once the agent is active, never on a timer. Message times are tuned to a 60 second start.
 */

export const ONBOARDING_FIRST_STATUS_POLL_MS = 5_000;
export const ONBOARDING_STATUS_POLL_INTERVAL_MS = 3_000;

/** Offsets from the moment the user submits the agent name. */
export const ONBOARDING_MESSAGE_TIMES = {
  created: 2_000,
  editInfo: 7_000,
  telegramSetup: 12_000,
  capability: 17_000,
  continuity: 22_000,
  viewAgents: 27_000,
  agentsPage: 32_000,
  sidebarNav: 37_000,
} as const;

export type OnboardingMessageKey = keyof typeof ONBOARDING_MESSAGE_TIMES;

/** The message that shows the Telegram / notifications setup. Messages after it wait for the user (see pause). */
export const ONBOARDING_PAUSE_AFTER: OnboardingMessageKey = 'telegramSetup';

/** Messages after the pause keep the same gaps, counted from the moment the pause ends. */
export function resumedMessageOffsets(resumeAtMs: number): Partial<Record<OnboardingMessageKey, number>> {
  const keys = Object.keys(ONBOARDING_MESSAGE_TIMES) as OnboardingMessageKey[];
  const pauseIndex = keys.indexOf(ONBOARDING_PAUSE_AFTER);
  const resumed: Partial<Record<OnboardingMessageKey, number>> = {};
  const pauseAt = ONBOARDING_MESSAGE_TIMES[ONBOARDING_PAUSE_AFTER];
  for (const key of keys.slice(pauseIndex + 1)) {
    resumed[key] = resumeAtMs + (ONBOARDING_MESSAGE_TIMES[key] - pauseAt);
  }
  return resumed;
}

export const ONBOARDING_AGENT_NAME_MAX_LENGTH = 100;

/** Mirrors the API's AgentNameSchema: 1-100 chars, and 'all' / '*' are reserved. */
export function isValidOnboardingAgentName(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  return trimmed.length >= 1
    && trimmed.length <= ONBOARDING_AGENT_NAME_MAX_LENGTH
    && normalized !== 'all'
    && normalized !== '*';
}

/** Delay until the next status poll. The first poll is at 5s; later polls every 3s. */
export function nextStatusPollDelay(elapsedMs: number, pollsDone: number): number {
  if (pollsDone === 0) {
    return Math.max(ONBOARDING_FIRST_STATUS_POLL_MS - elapsedMs, 0);
  }
  return ONBOARDING_STATUS_POLL_INTERVAL_MS;
}

/** The user is sent to /agents once the agent is active. */
export function shouldRedirectToAgents(status: string | null): boolean {
  return status === 'active';
}

/** How long the agent may take to start before the user sees the stuck-agent warning. */
export const ONBOARDING_STUCK_AFTER_MS = 60_000;
/** How long the "Redirecting to AI agents page" line shows before navigating. */
export const ONBOARDING_REDIRECT_DELAY_MS = 2_000;

const FAILED_AGENT_STATUSES = new Set(['crashed']);

/**
 * The warning shows at once on a failed start request or a crashed agent, and after the stuck budget otherwise.
 * It never shows once the agent is active. A 'stopped' or 'starting' agent does not trigger it early.
 */
export function shouldShowStuckWarning(input: {
  status: string | null;
  startFailed: boolean;
  budgetExpired: boolean;
}): boolean {
  if (input.status === 'active') return false;
  if (input.startFailed) return true;
  if (input.status !== null && FAILED_AGENT_STATUSES.has(input.status)) return true;
  return input.budgetExpired;
}

/**
 * TEMP(onboarding-start-delay): test-only, remove after testing. Holds an agent's reported 'active' status back, so the
 * onboarding timing and warning can be tested with a slow start. Works only in dev builds (`import.meta.env.DEV`).
 * Use: /onboarding?onboardingStartDelay=45 (seconds, the agent looks active after 45s) or onboardingStartDelay=never (never active).
 * To remove: delete this block, its call in OnboardingPage.tsx (`simulatedStartDelay`, `applySimulatedStatus`) and its tests.
 */
export type SimulatedStartDelay = number | 'never' | null;

export function readSimulatedStartDelay(search: string, isDev: boolean): SimulatedStartDelay {
  if (!isDev) return null;
  const raw = new URLSearchParams(search).get('onboardingStartDelay');
  if (raw === null) return null;
  if (raw === 'never') return 'never';
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Returns the status the onboarding page should act on. Only 'active' can be held back. */
export function applySimulatedStatus(status: string, elapsedMs: number, delay: SimulatedStartDelay): string {
  if (status !== 'active' || delay === null) return status;
  if (delay === 'never') return 'starting';
  return elapsedMs < delay ? 'starting' : status;
}
