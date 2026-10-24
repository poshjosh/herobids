import { describe, expect, it } from 'vitest';
import { buildNotificationPayload, NOTIFICATION_BODY, shouldNotify, type NotificationClass } from './payload.js';

describe('shouldNotify', () => {
  const enabledDefault: { enabled: boolean; eventClasses: NotificationClass[] } = {
    enabled: true,
    eventClasses: ['agent.reply', 'agent.question'],
  };

  const cases: Array<[string, NotificationClass, { enabled: boolean; eventClasses: NotificationClass[] }, boolean]> = [
    ['listed class, feature on', 'agent.reply', { enabled: true, eventClasses: ['agent.reply'] }, true],
    ['second listed class, feature on', 'agent.question', enabledDefault, true],
    ['unlisted class, feature on', 'task.completed', enabledDefault, false],
    ['listed class, feature off', 'agent.reply', { enabled: false, eventClasses: ['agent.reply'] }, false],
    ['unlisted class, feature off', 'agent.question', { enabled: false, eventClasses: [] }, false],
  ];

  it.each(cases)('%s → notify=%s', (_label, eventClass, config, expected) => {
    expect(shouldNotify(eventClass, config).ok).toBe(expected);
  });

  it('returns notification.class_disabled when the feature is off', () => {
    const result = shouldNotify('agent.reply', { enabled: false, eventClasses: ['agent.reply'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('notification.class_disabled');
  });

  it('returns notification.class_disabled when the class is not listed', () => {
    const result = shouldNotify('task.completed', { enabled: true, eventClasses: ['agent.reply'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('notification.class_disabled');
      expect(result.error.context).toEqual({ eventClass: 'task.completed' });
    }
  });
});

describe('buildNotificationPayload', () => {
  it('builds a fixed-body payload that links to the agent', () => {
    const payload = buildNotificationPayload({
      agentId: 'agent-42',
      agentName: 'Research Bot',
      eventClass: 'agent.question',
    });

    expect(payload).toEqual({
      agentId: 'agent-42',
      agentName: 'Research Bot',
      title: 'Research Bot',
      body: NOTIFICATION_BODY,
      url: '/agents/agent-42',
      eventClass: 'agent.question',
    });
  });

  it('carries only the documented fields, with no message text or credentials', () => {
    const payload = buildNotificationPayload({
      agentId: 'agent-42',
      agentName: 'Research Bot',
      eventClass: 'agent.reply',
    });

    expect(Object.keys(payload).sort()).toEqual(
      ['agentId', 'agentName', 'body', 'eventClass', 'title', 'url'],
    );
    expect(payload.body).toBe('You have a new message');
  });

  it('encodes the agent id in the url path', () => {
    const payload = buildNotificationPayload({
      agentId: 'a/b?c',
      agentName: 'X',
      eventClass: 'agent.reply',
    });

    expect(payload.url).toBe('/agents/a%2Fb%3Fc');
  });
});
