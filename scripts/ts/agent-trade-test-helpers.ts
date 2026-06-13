export interface AgentActivityEntry {
  id: string;
  timestamp: string;
  eventType: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface ToolResultPayload {
  toolName?: string;
  status?: string;
  summary?: string;
  positionCount?: number;
  hasOpenPositions?: boolean;
}

export function getToolResultPayload(entry: AgentActivityEntry): ToolResultPayload | null {
  const payloadValue = entry.detail['payload'];
  if (!payloadValue || typeof payloadValue !== 'object') {
    return null;
  }

  const payload = payloadValue as Record<string, unknown>;
  const metadataValue = payload['metadata'];
  const metadata = metadataValue && typeof metadataValue === 'object'
    ? metadataValue as Record<string, unknown>
    : undefined;

  return {
    toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : undefined,
    status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
    summary: typeof payload['summary'] === 'string' ? payload['summary'] : undefined,
    ...(metadata ? {
      positionCount: typeof metadata['positionCount'] === 'number' ? metadata['positionCount'] : undefined,
      hasOpenPositions: typeof metadata['hasOpenPositions'] === 'boolean' ? metadata['hasOpenPositions'] : undefined,
    } : {}),
  };
}

export function selectListPositionsResult(
  entries: AgentActivityEntry[],
  notBeforeIso: string,
): AgentActivityEntry | null {
  const notBeforeMs = new Date(notBeforeIso).getTime();

  const qualifyingEntries = entries.filter((entry) => {
    if (entry.eventType !== 'tool.result') return false;
    if (new Date(entry.timestamp).getTime() < notBeforeMs) return false;
    const payload = getToolResultPayload(entry);
    return payload?.toolName === 'list_positions' && payload.status === 'ok';
  });

  if (qualifyingEntries.length === 0) {
    return null;
  }

  return [...qualifyingEntries].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  )[0] ?? null;
}