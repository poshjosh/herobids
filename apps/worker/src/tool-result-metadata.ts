export interface ToolResultMetadata {
  [key: string]: unknown;
  positionCount?: number;
  hasOpenPositions?: boolean;
}

export function buildToolResultMetadata(toolName: string, resultData: unknown): ToolResultMetadata | undefined {
  if (toolName !== 'list_positions' || !resultData || typeof resultData !== 'object') {
    return undefined;
  }

  const resultRecord = resultData as Record<string, unknown>;
  const positionsValue = resultRecord['positions'];
  if (!Array.isArray(positionsValue)) {
    return undefined;
  }

  return {
    positionCount: positionsValue.length,
    hasOpenPositions: positionsValue.length > 0,
  };
}