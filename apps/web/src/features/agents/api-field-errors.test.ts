import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api-client.js';
import { mapApiErrorToFieldErrors } from './api-field-errors.js';

const maxHoldIssue = { path: ['runtimePolicyOverrides', 'maxHoldDurationMs'], message: 'too small' };

describe('mapApiErrorToFieldErrors', () => {
  it('maps the max-hold issue path onto the maxHoldDurationMs field', () => {
    const error = new ApiError(400, 'validation_error', 'Invalid', undefined, [maxHoldIssue]);
    expect(mapApiErrorToFieldErrors(error)).toEqual({
      fieldErrors: { maxHoldDurationMs: 'too small' },
      fullyMapped: true,
    });
  });

  it('keeps the banner when some issues have no field', () => {
    const error = new ApiError(400, 'validation_error', 'Invalid', undefined, [
      maxHoldIssue,
      { path: ['name'], message: 'bad name' },
    ]);
    expect(mapApiErrorToFieldErrors(error)).toEqual({
      fieldErrors: { maxHoldDurationMs: 'too small' },
      fullyMapped: false,
    });
  });

  it('maps nothing for non-validation or non-API errors', () => {
    expect(mapApiErrorToFieldErrors(new ApiError(500, 'internal_error', 'boom')).fieldErrors).toEqual({});
    expect(mapApiErrorToFieldErrors(new Error('x'))).toEqual({ fieldErrors: {}, fullyMapped: false });
  });
});
