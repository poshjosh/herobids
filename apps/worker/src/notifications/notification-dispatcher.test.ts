import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppConfig } from '@herobids/domain';
import { NotificationDispatcher, type NotificationDispatchEvent, type NotificationDispatcherDeps } from './notification-dispatcher.js';

vi.mock('../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const EVENT: NotificationDispatchEvent = {
  userId: 'user-1',
  agentId: 'agent-1',
  agentName: 'Research Bot',
  eventKey: 'agent-1:out-1',
  eventClass: 'agent.question',
};

type NotificationsConfig = AppConfig['messaging']['notifications'];

function makeConfig(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return {
    enabled: true,
    eventClasses: ['agent.reply', 'agent.question'],
    webPush: {
      enabled: true,
      vapidSubject: 'mailto:ops@example.test',
      vapidPublicKey: 'public',
      vapidPrivateKey: 'private',
      ttlSeconds: 86400,
      urgency: 'normal',
    },
    email: {
      enabled: true,
      eventClasses: ['agent.question'],
      maxPerUserPerDay: 10,
      userDefaultEnabled: true,
    },
    ...overrides,
  };
}

function makeSubscription(id: string) {
  return {
    id,
    userId: 'user-1',
    endpoint: `https://push.example.test/send/${id}`,
    p256dh: `p256dh-${id}`,
    auth: `auth-${id}`,
    userAgent: null,
    createdAt: new Date(0),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    revokedAt: null,
  };
}

type ReserveResult =
  | { outcome: 'reserved'; id: string }
  | { outcome: 'duplicate' }
  | { outcome: 'rate_limited' };

interface Harness {
  deps: NotificationDispatcherDeps;
  channelNotify: ReturnType<typeof vi.fn>;
  listActiveForUser: ReturnType<typeof vi.fn>;
  emailNotify: ReturnType<typeof vi.fn>;
  reserveEmailIfUnderCap: ReturnType<typeof vi.fn>;
  countEmailSince: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  getUserNotificationPreferences: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  config?: Partial<NotificationsConfig>;
  subscriptions?: ReturnType<typeof makeSubscription>[];
  pushResult?: 'ok' | 'fail';
  withEmail?: boolean;
  withWebPush?: boolean;
  preferences?: unknown;
  dailyEmailCount?: number;
  reserveResult?: ReserveResult;
} = {}): Harness {
  const channelNotify = vi.fn(async () => (options.pushResult === 'fail'
    ? { ok: false as const, error: { code: 'notification.provider_failed', message: 'provider_failed' } }
    : { ok: true as const, data: { subscriptionId: 'x' } }));
  const listActiveForUser = vi.fn(async () => options.subscriptions ?? []);
  const emailNotify = vi.fn(async () => ({ ok: true as const, data: { messageId: 'ses-1' } }));
  const reserveEmailIfUnderCap = vi.fn(async (): Promise<ReserveResult> => options.reserveResult ?? { outcome: 'reserved', id: 'row-1' });
  const countEmailSince = vi.fn(async () => options.dailyEmailCount ?? 0);
  const updateStatus = vi.fn(async () => undefined);
  const getUserNotificationPreferences = vi.fn(async () => options.preferences ?? null);

  const deps: NotificationDispatcherDeps = {
    config: makeConfig(options.config),
    webPush: options.withWebPush === false
      ? undefined
      : { channel: { notify: channelNotify }, subscriptions: { listActiveForUser } },
    email: options.withEmail === false ? undefined : { notify: emailNotify },
    deliveries: { reserveEmailIfUnderCap, countEmailSince, updateStatus },
    preferences: { getUserNotificationPreferences },
  };
  return { deps, channelNotify, listActiveForUser, emailNotify, reserveEmailIfUnderCap, countEmailSince, updateStatus, getUserNotificationPreferences };
}

describe('NotificationDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends one email when the user has no active subscription', async () => {
    const h = makeHarness({ subscriptions: [] });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(result).toEqual({ ok: true, data: { route: 'email', reason: 'notification.no_subscription', emailDelivered: true } });
    expect(h.channelNotify).not.toHaveBeenCalled();
    expect(h.emailNotify).toHaveBeenCalledTimes(1);
    expect(h.reserveEmailIfUnderCap).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      eventKey: 'agent-1:out-1',
      channel: 'email',
      reason: 'notification.no_subscription',
      since: expect.any(Date),
      maxPerUserPerDay: 10,
    });
    expect(h.updateStatus).toHaveBeenCalledWith('row-1', 'sent', 'notification.no_subscription');
  });

  it('sends no email when a push succeeded', async () => {
    const h = makeHarness({ subscriptions: [makeSubscription('sub-1')] });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.channelNotify).toHaveBeenCalledTimes(1);
    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(h.reserveEmailIfUnderCap).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.push_succeeded', emailDelivered: false } });
  });

  it('sends one email when every push to the user failed', async () => {
    const h = makeHarness({
      subscriptions: [makeSubscription('sub-1'), makeSubscription('sub-2')],
      pushResult: 'fail',
    });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.channelNotify).toHaveBeenCalledTimes(2);
    expect(h.emailNotify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { route: 'email', reason: 'notification.push_all_failed', emailDelivered: true } });
  });

  it('sends nothing when the same event key was already recorded for email', async () => {
    const h = makeHarness({ subscriptions: [], reserveResult: { outcome: 'duplicate' } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.duplicate_event', emailDelivered: false } });
  });

  it('records a failed email and does not retry it', async () => {
    const h = makeHarness({ subscriptions: [] });
    h.emailNotify.mockResolvedValueOnce({ ok: false, error: { code: 'email.timeout', message: 'timed out' } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).toHaveBeenCalledTimes(1);
    expect(h.updateStatus).toHaveBeenCalledWith('row-1', 'failed', 'email.timeout');
    expect(result).toEqual({ ok: true, data: { route: 'email', reason: 'notification.no_subscription', emailDelivered: false } });
  });

  it('blocks email once the daily cap is reached', async () => {
    const h = makeHarness({ subscriptions: [], dailyEmailCount: 10 });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(h.reserveEmailIfUnderCap).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.rate_limited', emailDelivered: false } });
  });

  it('sends nothing when the cap is reached inside the atomic reservation, even if the pre-check passed', async () => {
    const h = makeHarness({ subscriptions: [], dailyEmailCount: 0, reserveResult: { outcome: 'rate_limited' } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.reserveEmailIfUnderCap).toHaveBeenCalledTimes(1);
    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.rate_limited', emailDelivered: false } });
  });

  it('does nothing when the feature is off', async () => {
    const h = makeHarness({ subscriptions: [], config: { enabled: false } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.listActiveForUser).not.toHaveBeenCalled();
    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.class_disabled', emailDelivered: false } });
  });

  it('does nothing when the event class is not on the push list', async () => {
    const h = makeHarness({ subscriptions: [], config: { eventClasses: ['agent.reply'] } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.class_disabled', emailDelivered: false } });
  });

  it('sends no email when the email list excludes the event class', async () => {
    const h = makeHarness({ subscriptions: [], config: { email: { enabled: true, eventClasses: [], maxPerUserPerDay: 10, userDefaultEnabled: true } } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.class_not_emailed', emailDelivered: false } });
  });

  it('sends no email when email fallback is disabled in config', async () => {
    const h = makeHarness({ subscriptions: [], config: { email: { enabled: false, eventClasses: ['agent.question'], maxPerUserPerDay: 10, userDefaultEnabled: true } } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.class_not_emailed', emailDelivered: false } });
  });

  it('sends no email when the user opted out', async () => {
    const h = makeHarness({
      subscriptions: [],
      preferences: { notifications: { emailFallback: { enabled: false } } },
    });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.opted_out', emailDelivered: false } });
  });

  it('sends no email to a user with no choice when the operator default is opt-in', async () => {
    const h = makeHarness({ subscriptions: [], config: { email: { enabled: true, eventClasses: ['agent.question'], maxPerUserPerDay: 10, userDefaultEnabled: false } } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.opted_out', emailDelivered: false } });
  });

  it('sends email to a user who explicitly opted in when the operator default is opt-in', async () => {
    const h = makeHarness({
      subscriptions: [],
      config: { email: { enabled: true, eventClasses: ['agent.question'], maxPerUserPerDay: 10, userDefaultEnabled: false } },
      preferences: { notifications: { emailFallback: { enabled: true } } },
    });

    await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).toHaveBeenCalledTimes(1);
  });

  it('records nothing and sends nothing when no email client is configured', async () => {
    const h = makeHarness({ subscriptions: [], withEmail: false });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.reserveEmailIfUnderCap).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.email_disabled', emailDelivered: false } });
  });

  it('uses email when Web Push is not wired, even if the user has stored subscriptions', async () => {
    const h = makeHarness({ withWebPush: false });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.listActiveForUser).not.toHaveBeenCalled();
    expect(h.emailNotify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { route: 'email', reason: 'notification.no_subscription', emailDelivered: true } });
  });

  it('keeps trying the other subscriptions when one push throws, and sends no email if one succeeds', async () => {
    const h = makeHarness({ subscriptions: [makeSubscription('sub-1'), makeSubscription('sub-2')] });
    h.channelNotify
      .mockRejectedValueOnce(new Error('push service unreachable'))
      .mockResolvedValueOnce({ ok: true, data: { subscriptionId: 'sub-2' } });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.channelNotify).toHaveBeenCalledTimes(2);
    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.push_succeeded', emailDelivered: false } });
  });

  it('returns dispatch_failed and sends no email when the subscription lookup fails', async () => {
    const h = makeHarness({ subscriptions: [] });
    h.listActiveForUser.mockRejectedValueOnce(new Error('db down'));

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.emailNotify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { code: 'notification.dispatch_failed', message: 'dispatch_failed' } });
  });

  it('reads no preferences or email counts when push succeeded, so push-only sends add no database reads', async () => {
    const h = makeHarness({ subscriptions: [makeSubscription('sub-1')] });

    await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.getUserNotificationPreferences).not.toHaveBeenCalled();
    expect(h.countEmailSince).not.toHaveBeenCalled();
  });

  it('reads no preferences, email counts, or ledger rows when no email client is configured', async () => {
    const h = makeHarness({ subscriptions: [], withEmail: false });

    const result = await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.getUserNotificationPreferences).not.toHaveBeenCalled();
    expect(h.countEmailSince).not.toHaveBeenCalled();
    expect(h.reserveEmailIfUnderCap).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { route: 'none', reason: 'notification.email_disabled', emailDelivered: false } });
  });

  it('reads no preferences or email counts when email is disabled in config', async () => {
    const h = makeHarness({ subscriptions: [], config: { email: { enabled: false, eventClasses: ['agent.question'], maxPerUserPerDay: 10, userDefaultEnabled: true } } });

    await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.getUserNotificationPreferences).not.toHaveBeenCalled();
    expect(h.countEmailSince).not.toHaveBeenCalled();
  });

  it('passes only the fixed notification text to the push channel', async () => {
    const h = makeHarness({ subscriptions: [makeSubscription('sub-1')] });

    await new NotificationDispatcher(h.deps).dispatch(EVENT);

    expect(h.channelNotify).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub-1', endpoint: 'https://push.example.test/send/sub-1' }),
      { agentId: 'agent-1', agentName: 'Research Bot', title: 'Research Bot', body: 'You have a new message', url: '/agents/agent-1', eventClass: 'agent.question' },
    );
  });
});
