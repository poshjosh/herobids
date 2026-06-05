import type { AlertsConfig, TelegramChannelConfig } from '@herobids/domain';

/** Severity levels for journal events */
export type AlertSeverity = 'info' | 'warn' | 'critical';

/** A journal event row (from scanAfter) */
export interface JournalEventRow {
  id: string;
  tradingInstanceId?: string | null;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** A routing decision: which channels should receive this event */
export interface AlertRouting {
  event: JournalEventRow;
  destinations: Array<{ channel: 'telegram'; chatId: string }>;
}

/** Known event type → severity mapping */
const SEVERITY_MAP: Record<string, AlertSeverity> = {
  'risk.': 'critical',
  'execution.failure': 'critical',
  'stream.disconnect': 'warn',
  'instance.crashed': 'critical',
  'instance.tick_error': 'warn',
  'instance.stopped': 'info',
  'reconciliation.drift_detected': 'warn',
  'reconciliation.correction': 'info',
};

/** Determine severity of a journal event based on its type prefix */
export function classifySeverity(eventType: string): AlertSeverity {
  for (const [prefix, severity] of Object.entries(SEVERITY_MAP)) {
    if (eventType.startsWith(prefix) || eventType === prefix) {
      return severity;
    }
  }
  return 'info';
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };

/** Check if a channel should receive this event based on prefix and severity filters */
function channelMatches(channel: TelegramChannelConfig, eventType: string, severity: AlertSeverity): boolean {
  const severityOk = SEVERITY_ORDER[severity] >= SEVERITY_ORDER[channel.minSeverity];
  if (!severityOk) return false;

  const prefixOk = channel.eventPrefixes.some((prefix) => eventType.startsWith(prefix));
  return prefixOk;
}

/**
 * Evaluate alert routing for a batch of journal events.
 * Returns only events that should be dispatched, with their destinations.
 */
export function evaluateAlertPolicy(
  events: JournalEventRow[],
  config: AlertsConfig,
): AlertRouting[] {
  if (!config.enabled) return [];
  if (config.telegram.channels.length === 0) return [];

  const results: AlertRouting[] = [];

  for (const event of events) {
    const severity = classifySeverity(event.type);
    const destinations: AlertRouting['destinations'] = [];

    for (const channel of config.telegram.channels) {
      if (channelMatches(channel, event.type, severity)) {
        destinations.push({ channel: 'telegram', chatId: channel.chatId });
      }
    }

    if (destinations.length > 0) {
      results.push({ event, destinations });
    }
  }

  return results;
}
