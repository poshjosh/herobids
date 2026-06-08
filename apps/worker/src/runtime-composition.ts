import type { CapabilityReadiness, RuntimeDescriptor, RuntimeDescriptorUpdatePayload } from '@herobids/domain';

export interface RuntimeSessionMetrics {
  decisionsSubmitted: number;
  decisionsAccepted: number;
  decisionsRejected: number;
  lastPnlSummary: string | null;
  lastPositionSide: string | null;
  managedBots: Array<{ id: string; status: string; strategyPreset?: string; symbol?: string }> | null;
}

export interface RuntimeCompositionState {
  runtimeDescriptor: RuntimeDescriptor;
  sessionStartMs: number;
  tickCount: number;
  metrics: RuntimeSessionMetrics;
}

export interface RuntimeContextBlock {
  id: string;
  title: string;
  content: string;
  provider: string;
}

export interface RuntimeContextProvider {
  id: string;
  costTier: 'free' | 'cheap' | 'expensive';
  requiredFamilies: string[];
  build: (state: RuntimeCompositionState) => RuntimeContextBlock | null;
}

export const RUNTIME_CONTEXT_PROVIDERS: RuntimeContextProvider[] = [
  {
    id: 'core-platform',
    costTier: 'free',
    requiredFamilies: [],
    build: (state) => ({
      id: 'corePlatformContext',
      title: 'Core Platform',
      provider: 'core-platform',
      content: [
        `Agent ID: ${state.runtimeDescriptor.agentId}`,
        `Goal: ${state.runtimeDescriptor.goal}`,
        `Execution mode: ${state.runtimeDescriptor.executionMode}`,
        `Tools visible: ${formatVisibleTools(state.runtimeDescriptor)}`,
        `Budgets: history=${state.runtimeDescriptor.budgets.maxHistoryMessages}, toolResults=${state.runtimeDescriptor.budgets.maxToolResultChars}, toolSchemas=${state.runtimeDescriptor.budgets.maxVisibleToolSchemas}`,
      ].join('\n'),
    }),
  },
  {
    id: 'readiness-summary',
    costTier: 'free',
    requiredFamilies: [],
    build: (state) => {
      const readinessLines = Object.entries(state.runtimeDescriptor.readinessByFamily);
      if (readinessLines.length === 0) {
        return {
          id: 'readinessSummary',
          title: 'Capability Readiness',
          provider: 'readiness-summary',
          content: 'No capability families are configured yet.',
        };
      }

      return {
        id: 'readinessSummary',
        title: 'Capability Readiness',
        provider: 'readiness-summary',
        content: readinessLines.map(([family, readiness]) => renderReadinessLine(family, readiness)).join('\n'),
      };
    },
  },
  {
    id: 'trading-context',
    costTier: 'cheap',
    requiredFamilies: ['trading'],
    build: (state) => {
      const readiness = state.runtimeDescriptor.readinessByFamily['trading'];
      const bindings = state.runtimeDescriptor.grantedBindingsByFamily['trading'] ?? [];
      const defaultBindingId = state.runtimeDescriptor.defaultBindingByFamily['trading'] ?? null;
      if (!readiness && bindings.length === 0) {
        return null;
      }

      const selectedBinding = bindings.find((binding) => binding.bindingId === defaultBindingId) ?? bindings[0] ?? null;
      const lines = [
        `Default binding: ${selectedBinding?.label ?? 'none'}`,
        `Binding ID: ${selectedBinding?.bindingId ?? 'none'}`,
        `Provider: ${selectedBinding?.provider ?? 'none'}`,
        `Readiness: ${readiness?.state ?? 'unconfigured'} (${readiness?.effectiveReady ? 'effective ready' : 'not ready'})`,
      ];

      if (state.metrics.lastPnlSummary) {
        lines.push(`Last P&L summary: ${state.metrics.lastPnlSummary}`);
      }
      if (state.metrics.lastPositionSide) {
        lines.push(`Current position side: ${state.metrics.lastPositionSide}`);
      }
      if (state.metrics.managedBots && state.metrics.managedBots.length > 0) {
        lines.push(`Managed bots: ${state.metrics.managedBots.map((bot) => `${bot.id}[${bot.status}]`).join(', ')}`);
      }

      return {
        id: 'tradingContext',
        title: 'Trading Context',
        provider: 'trading-context',
        content: lines.join('\n'),
      };
    },
  },
];

function formatVisibleTools(runtimeDescriptor: RuntimeDescriptor): string {
  const tools = new Set<string>();
  for (const skill of runtimeDescriptor.resolvedSkills) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
      if (tools.size >= runtimeDescriptor.budgets.maxVisibleToolSchemas) {
        break;
      }
    }
    if (tools.size >= runtimeDescriptor.budgets.maxVisibleToolSchemas) {
      break;
    }
  }
  return [...tools].join(', ') || 'none';
}

function renderReadinessLine(family: string, readiness: CapabilityReadiness): string {
  const bindingSuffix = readiness.bindingId ? ` binding=${readiness.bindingId}` : '';
  const reasonSuffix = readiness.reasons.length > 0 ? ` reasons=${readiness.reasons.join('; ')}` : '';
  return `${family}: ${readiness.state} (${readiness.agentEligibility}${bindingSuffix}${reasonSuffix})`;
}

export function createRuntimeCompositionState(runtimeDescriptor: RuntimeDescriptor): RuntimeCompositionState {
  return {
    runtimeDescriptor,
    sessionStartMs: Date.now(),
    tickCount: 0,
    metrics: {
      decisionsSubmitted: 0,
      decisionsAccepted: 0,
      decisionsRejected: 0,
      lastPnlSummary: null,
      lastPositionSide: null,
      managedBots: null,
    },
  };
}

export function updateRuntimeDescriptor(
  state: RuntimeCompositionState,
  runtimeDescriptor: RuntimeDescriptor,
): void {
  state.runtimeDescriptor = runtimeDescriptor;
}

export function applyRuntimeMessage(
  state: RuntimeCompositionState,
  message: Record<string, unknown>,
): string {
  const type = typeof message['type'] === 'string' ? message['type'] : 'unknown';
  const payload = (message['payload'] as Record<string, unknown> | undefined) ?? {};

  if (type === 'agent.runtime.config_update') {
    const update = payload['runtimeDescriptor'] as RuntimeDescriptorUpdatePayload['runtimeDescriptor'] | undefined;
    if (update) {
      updateRuntimeDescriptor(state, update);
      return `Runtime config updated: ${payload['reason'] ?? 'update'}`;
    }
    return 'Runtime config update received';
  }

  if (type === 'instance.context.snapshot') {
    const position = payload['position'] as Record<string, unknown> | undefined;
    const pnl = (payload['pnl'] as string | undefined) ?? (position?.['realizedPnl'] as string | undefined);
    if (pnl) {
      state.metrics.lastPnlSummary = pnl;
    }
    if (position?.['side']) {
      state.metrics.lastPositionSide = String(position['side']);
    }
    const symbol = payload['symbol'] ?? 'unknown';
    const price = payload['price'] ?? 'unknown';
    return `Market: ${symbol} @ ${price}`;
  }

  if (type === 'instance.decision.accepted') {
    state.metrics.decisionsAccepted++;
    return `Decision accepted: ${payload['decisionId'] ?? 'unknown'}`;
  }

  if (type === 'instance.decision.rejected') {
    state.metrics.decisionsRejected++;
    return `Decision rejected: ${payload['message'] ?? 'unknown'}`;
  }

  if (type === 'instance.execution.result') {
    return 'Execution result received';
  }

  if (type === 'instance.status') {
    const bots = payload['managedBots'] as RuntimeCompositionState['metrics']['managedBots'];
    if (bots) {
      state.metrics.managedBots = bots;
    }
    return `Platform status: ${payload['reason'] ?? payload['status'] ?? 'updated'}`;
  }

  return `Platform message: ${type}`;
}

export function buildContextBlocks(state: RuntimeCompositionState): RuntimeContextBlock[] {
  return RUNTIME_CONTEXT_PROVIDERS
    .filter((provider) => provider.requiredFamilies.every((family) => Boolean(state.runtimeDescriptor.readinessByFamily[family] || state.runtimeDescriptor.grantedBindingsByFamily[family])))
    .map((provider) => provider.build(state))
    .filter((block): block is RuntimeContextBlock => block !== null)
    .map((block) => ({
      ...block,
      content: block.content.slice(0, state.runtimeDescriptor.budgets.maxContextBlockChars),
    }));
}

export function buildSystemPrompt(state: RuntimeCompositionState): string {
  const skillInstructions = state.runtimeDescriptor.resolvedSkills.map((skill) => skill.instructions).join('\n\n');
  const allowedTools = formatVisibleTools(state.runtimeDescriptor);
  const contextBlocks = buildContextBlocks(state)
    .map((block) => `## ${block.title}\n${block.content}`)
    .join('\n\n');

  return [
    skillInstructions,
    '## Your Goal',
    state.runtimeDescriptor.goal,
    '## Available Tools',
    `You can call the following tools: ${allowedTools}.`,
    'To call a tool, output a JSON object in your response with this format:',
    '{"tool": "<tool_name>", "args": {...}}',
    '## Agent Identity',
    `Agent ID: ${state.runtimeDescriptor.agentId}`,
    `Execution mode: ${state.runtimeDescriptor.executionMode}`,
    '## Guard Rails',
    `- Daily token budget: ${state.runtimeDescriptor.guardrails.dailyTokenBudget ?? 'unlimited'} tokens`,
    `- Daily loss limit: ${state.runtimeDescriptor.guardrails.dailyLossLimit ?? 'none'}`,
    `- Max concurrent bots: ${state.runtimeDescriptor.guardrails.maxBots ?? 'unlimited'}`,
    contextBlocks ? `## Runtime Context\n${contextBlocks}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildTickUserContext(state: RuntimeCompositionState, incomingMessages: Array<Record<string, unknown>>): string {
  const elapsedMs = Date.now() - state.sessionStartMs;
  const elapsedMins = Math.round(elapsedMs / 60_000);
  const elapsedHours = Math.floor(elapsedMins / 60);
  const remainingMins = elapsedMins % 60;
  const elapsedStr = elapsedHours > 0 ? `${elapsedHours}h ${remainingMins}m` : `${elapsedMins}m`;

  const total = state.metrics.decisionsSubmitted;
  const performanceScore = total > 0
    ? Math.round((state.metrics.decisionsAccepted / total) * 10 * 10) / 10
    : null;

  const lines: string[] = [
    `## Session Progress`,
    `Session elapsed: ${elapsedStr}`,
    `Goal: ${state.runtimeDescriptor.goal}`,
    `Decisions this session: ${state.metrics.decisionsSubmitted} submitted, ${state.metrics.decisionsAccepted} accepted, ${state.metrics.decisionsRejected} rejected`,
  ];

  if (performanceScore !== null) {
    lines.push(`Performance score: ${performanceScore}/10 (decision acceptance rate)`);
  }

  if (state.metrics.lastPnlSummary) {
    lines.push(`Net P&L: ${state.metrics.lastPnlSummary}`);
  }
  if (state.metrics.lastPositionSide) {
    lines.push(`Current position: ${state.metrics.lastPositionSide}`);
  }
  if (state.metrics.managedBots && state.metrics.managedBots.length > 0) {
    const botLines = state.metrics.managedBots.map((bot) => {
      const preset = bot.strategyPreset?.replace(/[\n\r\t\x00-\x1f]/g, ' ').trim();
      const sym = bot.symbol?.replace(/[\n\r\t\x00-\x1f]/g, ' ').trim();
      return `  - ${bot.id} [${bot.status}]${preset ? ` strategy=${preset}` : ''}${sym ? ` symbol=${sym}` : ''}`;
    });
    lines.push(`Managed bots (${state.metrics.managedBots.length}):\n${botLines.join('\n')}`);
  }

  if (incomingMessages.length > 0) {
    lines.push('Recent platform updates:');
    lines.push(...incomingMessages.map((message) => applyRuntimeMessage(state, message)));
  }

  return lines.join('\n');
}

export function getVisibleToolNames(state: RuntimeCompositionState): string[] {
  const tools = new Set<string>();
  for (const skill of state.runtimeDescriptor.resolvedSkills) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
      if (tools.size >= state.runtimeDescriptor.budgets.maxVisibleToolSchemas) {
        return [...tools];
      }
    }
  }
  return [...tools];
}