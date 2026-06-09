export interface ContextDiffResult {
  mode: 'full' | 'diff';
  content: string;
  estimatedTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function summarizeDiff(previousContext: string, currentContext: string, maxChangedLines: number): string[] {
  const previousLines = previousContext.split('\n');
  const currentLines = currentContext.split('\n');
  const changedLines: string[] = [];

  const maxLength = Math.max(previousLines.length, currentLines.length);
  for (let index = 0; index < maxLength; index++) {
    const previousLine = previousLines[index] ?? '';
    const currentLine = currentLines[index] ?? '';
    if (currentLine !== previousLine) {
      if (previousLine.trim().length > 0) {
        changedLines.push(`- ${previousLine}`);
      }
      if (currentLine.trim().length > 0) {
        changedLines.push(`+ ${currentLine}`);
      }
    }
    if (changedLines.length >= maxChangedLines) {
      break;
    }
  }

  return changedLines;
}

function extractHeadingSignature(context: string): string {
  return context
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .join('\n');
}

export function buildIncrementalContext(params: {
  previousContext: string | null;
  currentContext: string;
  tickNumber: number;
  fullContextEveryTicks: number;
  maxDiffTokens: number;
  maxChangedLines: number;
}): ContextDiffResult {
  const { fullContextEveryTicks, maxDiffTokens, maxChangedLines } = params;

  if (!params.previousContext || params.tickNumber % fullContextEveryTicks === 0) {
    return {
      mode: 'full',
      content: params.currentContext,
      estimatedTokens: estimateTokens(params.currentContext),
    };
  }

  const changedLines = summarizeDiff(params.previousContext, params.currentContext, maxChangedLines);
  const previousHeadings = extractHeadingSignature(params.previousContext);
  const currentHeadings = extractHeadingSignature(params.currentContext);
  if (previousHeadings !== currentHeadings) {
    return {
      mode: 'full',
      content: params.currentContext,
      estimatedTokens: estimateTokens(params.currentContext),
    };
  }

  const diffContent = changedLines.length > 0
    ? ['## Context Diff', ...changedLines].join('\n')
    : '## Context Diff\n- No material changes from the prior tick.';
  const estimatedTokens = estimateTokens(diffContent);

  if (estimatedTokens > maxDiffTokens) {
    return {
      mode: 'full',
      content: params.currentContext,
      estimatedTokens: estimateTokens(params.currentContext),
    };
  }

  return {
    mode: 'diff',
    content: diffContent,
    estimatedTokens,
  };
}