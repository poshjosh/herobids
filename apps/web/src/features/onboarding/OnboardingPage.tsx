import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useIntl } from 'react-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { PageShell, LoadingRows } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { EditIcon, PauseIcon, PlayIcon, StopIcon } from '../agents/AgentActionIcons.js';
import { NotificationsBlock } from '../notifications/NotificationsBlock.js';
import {
  ONBOARDING_AGENT_NAME_MAX_LENGTH,
  ONBOARDING_MESSAGE_TIMES,
  ONBOARDING_PAUSE_AFTER,
  ONBOARDING_REDIRECT_DELAY_MS,
  ONBOARDING_STUCK_AFTER_MS,
  applySimulatedStatus,
  isValidOnboardingAgentName,
  nextStatusPollDelay,
  readSimulatedStartDelay,
  resumedMessageOffsets,
  shouldRedirectToAgents,
  shouldShowStuckWarning,
  type OnboardingMessageKey,
} from './onboardingTiming.js';

const MESSAGE_KEYS = Object.keys(ONBOARDING_MESSAGE_TIMES) as OnboardingMessageKey[];
/** Messages up to and including the setup step show on their timers. The rest wait for the pause to end. */
const MESSAGE_KEYS_BEFORE_PAUSE = MESSAGE_KEYS.filter(
  (key) => ONBOARDING_MESSAGE_TIMES[key] <= ONBOARDING_MESSAGE_TIMES[ONBOARDING_PAUSE_AFTER],
);
/** The last timed message. The still-starting line shows once it has appeared. */
const LAST_TIMED_MESSAGE: OnboardingMessageKey = 'sidebarNav';

const MESSAGE_IDS: Record<OnboardingMessageKey, string> = {
  created: 'onboarding.msgCreated',
  editInfo: 'onboarding.msgEditInfo',
  telegramSetup: 'onboarding.msgTelegram',
  capability: 'onboarding.msgCapability',
  continuity: 'onboarding.msgContinuity',
  viewAgents: 'onboarding.msgViewAgents',
  agentsPage: 'onboarding.msgAgentsPage',
  sidebarNav: 'onboarding.msgSidebarNav',
};

/** Icons in the edit message. Colours match the row buttons on /agents. */
const INLINE_ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  verticalAlign: 'middle',
  width: '22px',
  height: '22px',
  margin: '0 3px',
  borderRadius: '5px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-secondary)',
};

const editMessageValues = {
  play: <span style={{ ...INLINE_ICON_STYLE, color: 'var(--color-success)', borderColor: 'var(--color-success)' }}><PlayIcon /></span>,
  pause: <span style={INLINE_ICON_STYLE}><PauseIcon /></span>,
  edit: <span style={INLINE_ICON_STYLE}><EditIcon /></span>,
  stop: <span style={{ ...INLINE_ICON_STYLE, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}><StopIcon /></span>,
};


/**
 * Shown after login. Asks for an agent name, creates the agent, then keeps the user
 * engaged with timed messages until the agent is active and redirects to /agents.
 * Shows a stuck-agent warning if the agent does not start in time or the start request fails.
 */
export function OnboardingPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // TEMP(onboarding-start-delay): test-only, dev builds only. See readSimulatedStartDelay in onboardingTiming.ts.
  const location = useLocation();
  const simulatedStartDelay = readSimulatedStartDelay(location.search, import.meta.env.DEV);

  const agentList = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [shownMessages, setShownMessages] = useState<ReadonlySet<OnboardingMessageKey>>(() => new Set());
  const [status, setStatus] = useState<string | null>(null);
  // Elapsed ms from submit at which the user finished (or skipped) the setup step. Null while paused.
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [budgetExpired, setBudgetExpired] = useState(false);
  // Latched once shown, so the timed messages do not restart if the status changes later.
  const [warned, setWarned] = useState(false);
  const redirecting = shouldRedirectToAgents(status);
  // Timed messages and the pause stop once the agent is active or the warning is shown.
  const stopped = redirecting || warned;
  const paused = shownMessages.has(ONBOARDING_PAUSE_AFTER) && resumeAt === null && !stopped;

  // Pausing ends on the first setup action, a setup step that settles, or Skip. Only the first call counts.
  const resumeAfterSetup = useCallback(() => {
    if (resumeAt !== null || startedAt === null) return;
    setResumeAt(Date.now() - startedAt);
  }, [resumeAt, startedAt]);
  // Always available once the warning shows, so the user can still reach their agents.
  const goToAgentsLink = (
    <Link to="/agents" className="try-page-send-btn" style={{ marginTop: '12px' }}>
      {intl.formatMessage({ id: 'onboarding.goToAgents' })}
    </Link>
  );

  // Returning users who already have agents go straight to their agents.
  const hasAgents = (agentList.data?.length ?? 0) > 0;
  useEffect(() => {
    if (agentList.isSuccess && hasAgents && !agent) navigate('/agents', { replace: true });
  }, [agentList.isSuccess, hasAgents, agent, navigate]);

  // Timed messages up to the setup step, counted from the moment the name is submitted. They stop once the agent is active or the warning shows.
  useEffect(() => {
    if (!agent || stopped) return;
    const timers = MESSAGE_KEYS_BEFORE_PAUSE.map((key) => window.setTimeout(
      () => setShownMessages((prev) => new Set(prev).add(key)),
      ONBOARDING_MESSAGE_TIMES[key],
    ));
    return () => timers.forEach(window.clearTimeout);
  }, [agent, stopped]);

  // Messages after the setup step keep their gaps, counted from the moment the pause ends.
  useEffect(() => {
    if (!agent || stopped || resumeAt === null || startedAt === null) return;
    const offsets = resumedMessageOffsets(resumeAt);
    const timers = (Object.keys(offsets) as OnboardingMessageKey[]).map((key) => window.setTimeout(
      () => setShownMessages((prev) => new Set(prev).add(key)),
      Math.max((offsets[key] ?? 0) - (Date.now() - startedAt), 0),
    ));
    return () => timers.forEach(window.clearTimeout);
  }, [agent, stopped, resumeAt, startedAt]);

  // The stuck budget counts from submit. Polling continues in the background either way.
  useEffect(() => {
    if (!agent || redirecting) return;
    const timer = window.setTimeout(() => setBudgetExpired(true), ONBOARDING_STUCK_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [agent, redirecting]);

  useEffect(() => {
    if (!warned && shouldShowStuckWarning({ status, startFailed: startError !== null, budgetExpired })) {
      setWarned(true);
    }
  }, [warned, status, startError, budgetExpired]);

  // Short notice, then the agents page, which lists the agent.
  useEffect(() => {
    if (!redirecting) return;
    const timer = window.setTimeout(() => navigate('/agents', { replace: true }), ONBOARDING_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [redirecting, navigate]);

  // Polls the agent's status: first at 5s, then every 3s. Stops once it is active or the page closes.
  useEffect(() => {
    if (!agent || startedAt === null) return;
    let cancelled = false;
    let polls = 0;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const fresh = await agentsApi.get(agent.id);
        if (cancelled) return;
        // TEMP(onboarding-start-delay): holds 'active' back when the test delay is set. The cache is not written while held.
        const observed = applySimulatedStatus(fresh.status, Date.now() - startedAt, simulatedStartDelay);
        setStatus(observed);
        if (observed !== fresh.status) {
          polls += 1;
          timer = window.setTimeout(poll, nextStatusPollDelay(Date.now() - startedAt, polls));
          return;
        }
        // Keeps the cached list in step, so /agents does not show the status from submit time.
        queryClient.setQueryData<Agent[]>(['agents'], (list) => list?.map((a) => (a.id === fresh.id ? { ...a, ...fresh } : a)));
        if (fresh.status === 'active') {
          void queryClient.invalidateQueries({ queryKey: ['agents'] });
          return;
        }
      } catch {
        // Keep polling until the agent is active.
      }
      if (cancelled) return;
      polls += 1;
      timer = window.setTimeout(poll, nextStatusPollDelay(Date.now() - startedAt, polls));
    };

    timer = window.setTimeout(poll, nextStatusPollDelay(0, 0));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agent, startedAt, queryClient, simulatedStartDelay]);

  async function startAgent(agentId: string) {
    setStartError(null);
    try {
      await agentsApi.start(agentId);
    } catch (err) {
      setStartError(localizeApiError(intl, err, 'onboarding.startError'));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!isValidOnboardingAgentName(trimmed)) {
      setNameError(intl.formatMessage({ id: 'onboarding.nameInvalid' }));
      return;
    }
    setNameError(null);
    setCreateError(null);
    setSubmitting(true);
    try {
      const created = await agentsApi.create({ name: trimmed });
      // Without this, the cached empty list would send the user to the create form on /agents.
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setStartedAt(Date.now());
      setAgent(created);
      void startAgent(created.id);
    } catch (err) {
      setCreateError(localizeApiError(intl, err, 'onboarding.createError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (agentList.isLoading || (agentList.isSuccess && hasAgents && !agent)) {
    return <PageShell><LoadingRows count={3} /></PageShell>;
  }

  if (!agent) {
    return (
      <PageShell>
        <div className="try-page-message-row">
          <div className="try-page-bubble">{intl.formatMessage({ id: 'onboarding.askName' })}</div>
        </div>
        <form className="try-page-input-wrapper" onSubmit={(e) => void handleSubmit(e)}>
          <div className="try-page-input-row">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={intl.formatMessage({ id: 'onboarding.namePlaceholder' })}
              aria-label={intl.formatMessage({ id: 'onboarding.nameLabel' })}
              maxLength={ONBOARDING_AGENT_NAME_MAX_LENGTH}
              disabled={submitting}
              className="try-page-input"
              autoFocus
            />
            <button type="submit" disabled={submitting || !name.trim()} className="try-page-send-btn">
              {submitting ? intl.formatMessage({ id: 'onboarding.creating' }) : intl.formatMessage({ id: 'onboarding.nameSubmit' })}
            </button>
          </div>
          {nameError && <div className="try-page-error">{nameError}</div>}
          {createError && <div className="try-page-error">{createError}</div>}
        </form>
      </PageShell>
    );
  }

  return (
    <PageShell>
      {MESSAGE_KEYS.filter((key) => shownMessages.has(key)).map((key) => (
        <div key={key} className="try-page-message-row">
          <div className="try-page-bubble">
            {key === 'created' || key === 'capability'
              ? intl.formatMessage({ id: MESSAGE_IDS[key] }, { name: agent.name })
              : key === 'editInfo'
                ? intl.formatMessage({ id: MESSAGE_IDS[key] }, editMessageValues)
                : intl.formatMessage({ id: MESSAGE_IDS[key] })}
          </div>
          {key === 'telegramSetup' && (
            <div style={{ marginTop: '12px', maxWidth: '80%' }}>
              <NotificationsBlock
                variant="page"
                onSetupAction={resumeAfterSetup}
                onSettled={resumeAfterSetup}
              />
            </div>
          )}
        </div>
      ))}

      {paused && (
        <div className="try-page-message-row">
          <div style={{ maxWidth: '80%' }}>
            <p style={{ margin: '0 0 8px', color: 'var(--color-text-secondary)' }}>
              {intl.formatMessage({ id: 'onboarding.pauseHint' })}
            </p>
            <button type="button" className="try-page-send-btn" onClick={resumeAfterSetup}>
              {intl.formatMessage({ id: 'onboarding.pauseSkip' })}
            </button>
          </div>
        </div>
      )}

      {redirecting && (
        <div className="try-page-typing">{intl.formatMessage({ id: 'onboarding.redirecting' })}</div>
      )}

      {warned && !redirecting && (
        <>
          <div className="try-page-message-row">
            {/* TODO(support-ticket): show a ticket number once the support email is sent. See docs/features/pending/000-support-ticket-email/001-plan.md */}
            <div className="try-page-bubble" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: '16px',
                  height: '16px',
                  border: '2px solid var(--color-surface-3)',
                  borderTopColor: 'var(--color-brand)',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
              {intl.formatMessage({ id: 'onboarding.stuckWarning' })}
            </div>
          </div>
          <div className="try-page-message-row">{goToAgentsLink}</div>
        </>
      )}

      {!stopped && !paused && (
        <div className="try-page-typing">
          <span className="try-page-typing-dot">●</span>
          {shownMessages.has(LAST_TIMED_MESSAGE)
            ? intl.formatMessage({ id: 'onboarding.msgStillStarting' }, { name: agent.name })
            : intl.formatMessage({ id: 'try.typing' })}
        </div>
      )}
    </PageShell>
  );
}
