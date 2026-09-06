import { z } from 'zod';

/**
 * Strategy parameter registry — maps (strategyType, decisionMode) to strict parameter schemas.
 *
 * Each entry owns:
 * - schema: Zod schema for validating params
 * - defaults: default parameter values
 * - description: human-readable description for discovery/tool schemas
 *
 * Combinations with no parameters use z.object({}).strict().
 * No registry entry means the identity is unsupported.
 */

export interface StrategyParameterEntry {
  schema: z.ZodTypeAny;
  defaults: Record<string, unknown>;
  description: string;
}

// Supported strategy types and decision modes
export const SUPPORTED_STRATEGY_TYPES = [
  'momentum',
  'range',
  'contrarian',
  'swing',
  'scalper',
  'dca',
] as const;
export type SupportedStrategyType = (typeof SUPPORTED_STRATEGY_TYPES)[number];

export const SUPPORTED_DECISION_MODES = ['mechanical', 'llm', 'hybrid'] as const;
export type SupportedDecisionMode = (typeof SUPPORTED_DECISION_MODES)[number];

// Registry key format: `${type}:${decisionMode}`
const registry = new Map<string, StrategyParameterEntry>();

function register(
  type: SupportedStrategyType,
  decisionMode: SupportedDecisionMode,
  entry: StrategyParameterEntry,
): void {
  registry.set(`${type}:${decisionMode}`, entry);
}

function registerAllModes(
  type: SupportedStrategyType,
  entry: StrategyParameterEntry,
): void {
  for (const mode of SUPPORTED_DECISION_MODES) {
    register(type, mode, entry);
  }
}

// DCA: no parameters (timer-driven)
const DCA_ENTRY: StrategyParameterEntry = {
  schema: z.object({}).strict(),
  defaults: {},
  description:
    'DCA (Dollar-Cost Averaging) — timer-driven execution with no signal parameters.',
};

// Register DCA for all decision modes (params are empty regardless of mode).
// DCA's coverage across all modes is independent of the mechanical/agent split:
// its params are empty in every mode, so it is registered here at module load.
registerAllModes('dca', DCA_ENTRY);

/**
 * Initialise the registry with the mechanical param schemas from schema.ts.
 * Must be called once at startup before any mechanical strategy validation occurs.
 *
 * The registry is mechanical-first: this initializer only requires the mechanical
 * schema (for momentum/range/contrarian/swing/scalper) and a strict empty object
 * schema (for DCA). The agent decision modes (llm/hybrid) are registered separately
 * via {@link registerAgentDecisionModes} so a mechanical-only consumer never needs
 * the LLM/hybrid schemas to initialize the registry.
 *
 * @param schemas — the MechanicalParamsSchema and a strict empty object schema for DCA.
 */
export function initStrategyRegistry(schemas: {
  mechanical: z.ZodTypeAny;
  empty: z.ZodTypeAny;
}): void {
  // Update DCA entry with the real empty schema
  DCA_ENTRY.schema = schemas.empty;

  // Mechanical mode entries (momentum, range, contrarian, swing, scalper)
  const mechanicalTypes: SupportedStrategyType[] = [
    'momentum',
    'range',
    'contrarian',
    'swing',
    'scalper',
  ];
  for (const type of mechanicalTypes) {
    register(type, 'mechanical', {
      schema: schemas.mechanical,
      defaults: {},
      description: `${type} strategy — mechanical decision mode.`,
    });
  }
}

/**
 * Register the agent decision modes (llm/hybrid) into the registry.
 *
 * This is the agent-side counterpart to {@link initStrategyRegistry}. It keeps the
 * registration logic in the domain registry (so the Map stays the single source of
 * truth) while making the llm/hybrid modes an explicit, separate step rather than a
 * required init argument. Must be called before any llm/hybrid strategy validation
 * occurs.
 *
 * @param schemas — the LlmParamsSchema and HybridParamsSchema.
 */
export function registerAgentDecisionModes(schemas: {
  llm: z.ZodTypeAny;
  hybrid: z.ZodTypeAny;
}): void {
  // Hybrid mode: only momentum for now
  register('momentum', 'hybrid', {
    schema: schemas.hybrid,
    defaults: {},
    description: 'momentum strategy — hybrid decision mode (mechanical + LLM).',
  });

  // LLM mode: only momentum for now
  register('momentum', 'llm', {
    schema: schemas.llm,
    defaults: {},
    description: 'momentum strategy — LLM decision mode.',
  });
}

/**
 * Get the parameter entry for a given strategy type and decision mode.
 * Returns undefined if the combination is unsupported.
 */
export function getStrategyParameters(
  strategyType: string,
  decisionMode?: string,
): StrategyParameterEntry | undefined {
  const effectiveMode = decisionMode ?? 'mechanical';
  return registry.get(`${strategyType}:${effectiveMode}`);
}

/**
 * Check if a strategy type + decisionMode combination is supported.
 */
export function isStrategySupported(
  strategyType: string,
  decisionMode?: string,
): boolean {
  return getStrategyParameters(strategyType, decisionMode) !== undefined;
}

/**
 * Validate strategy params against the registered schema.
 * Returns the parsed (and defaulted) params, or throws ZodError.
 * Throws if the strategy type + decisionMode combination is unsupported.
 */
export function validateStrategyParams(
  strategyType: string,
  decisionMode: string | undefined,
  params: unknown,
): Record<string, unknown> {
  const entry = getStrategyParameters(strategyType, decisionMode);
  if (!entry) {
    throw new Error(
      `Unsupported strategy: type=${strategyType}, decisionMode=${decisionMode ?? 'mechanical'}`,
    );
  }
  // Defense-in-depth: initStrategyRegistry() must be called at startup, but if it
  // wasn't and an entry was pre-registered with a null schema, fail clearly.
  if (!entry.schema) {
    throw new Error(
      `Strategy registry not initialized for ${strategyType}:${decisionMode ?? 'mechanical'}. Call initStrategyRegistry() at startup.`,
    );
  }
  return entry.schema.parse(params ?? {}) as Record<string, unknown>;
}

/**
 * Get all registered (type, decisionMode) combinations for discovery.
 */
export function listStrategyCombinations(): Array<{
  type: string;
  decisionMode: string;
  description: string;
}> {
  const result: Array<{
    type: string;
    decisionMode: string;
    description: string;
  }> = [];
  for (const [key, entry] of registry.entries()) {
    const [type, decisionMode] = key.split(':') as [string, string];
    result.push({ type, decisionMode, description: entry.description });
  }
  return result;
}
