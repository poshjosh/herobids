import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import type { ExecutionMode, VenueType } from '../enums.js';
import { SWAP_VENUES, ORDERBOOK_VENUES } from '../config/schema.js';

export interface ExecutionCapabilityInput {
  actorType: 'agent' | 'bot';
  executionMode: ExecutionMode | null | undefined;
  venueType: VenueType;
}

export type ExecutionCapabilityErrorCode =
  | 'execution_mode_required'
  | 'paper_swap_not_supported';

export interface ExecutionCapabilityError {
  code: ExecutionCapabilityErrorCode;
  message: string;
}

/**
 * Derives the venue type from a provider string.
 * Returns undefined if the provider is not recognized.
 */
export function venueTypeFromProvider(provider: string): VenueType | undefined {
  if ((SWAP_VENUES as readonly string[]).includes(provider)) return 'swap';
  if ((ORDERBOOK_VENUES as readonly string[]).includes(provider)) return 'orderbook';
  return undefined;
}

/**
 * Validates that an actor's execution mode is compatible with the venue type.
 * Called at API write time to reject configurations the worker cannot execute.
 */
export function validateExecutionCapability(
  input: ExecutionCapabilityInput,
): Result<void, ExecutionCapabilityError> {
  if (input.executionMode == null) {
    return err({
      code: 'execution_mode_required',
      message: 'executionMode must be explicitly set for trading actors',
    });
  }

  if (input.executionMode === 'paper' && input.venueType === 'swap') {
    return err({
      code: 'paper_swap_not_supported',
      message: 'Paper mode is not supported for swap venues — use shadow or live',
    });
  }

  return ok(undefined);
}
