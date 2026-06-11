import type { ActivityEvent, AgentActivityEntry } from '../../lib/api-client.js';

export type ActivityFeedItem =
  | {
    kind: 'agent';
    id: string;
    timestamp: string;
    entry: AgentActivityEntry & { agentName?: string | null };
  }
  | {
    kind: 'bot';
    id: string;
    timestamp: string;
    event: ActivityEvent;
  };

function compareByTimestampDesc(left: ActivityFeedItem, right: ActivityFeedItem): number {
  const timestampDelta = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  return right.id.localeCompare(left.id);
}

export function mergeActivityFeedItems(
  agentEntries: Array<AgentActivityEntry & { agentName?: string | null }>,
  botEvents: ActivityEvent[],
): ActivityFeedItem[] {
  return [
    ...agentEntries.map((entry) => ({
      kind: 'agent' as const,
      id: entry.id,
      timestamp: entry.timestamp,
      entry,
    })),
    ...botEvents.map((event) => ({
      kind: 'bot' as const,
      id: event.id,
      timestamp: event.timestamp,
      event,
    })),
  ].sort(compareByTimestampDesc);
}