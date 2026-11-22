import { ApiError } from '../../lib/api-client.js';

/** API validation issue paths that the agent forms render against a specific field. */
const FIELD_KEY_BY_PATH: Record<string, string> = {
  'runtimePolicyOverrides.maxHoldDurationMs': 'maxHoldDurationMs',
};

export interface ApiFieldErrors {
  fieldErrors: Record<string, string>;
  /** True when every validation issue was mapped to a field, so a generic banner would only repeat them. */
  fullyMapped: boolean;
}

/** Map a 400 validation_error's issue paths onto form field keys. Unknown paths stay banner-only. */
export function mapApiErrorToFieldErrors(error: unknown): ApiFieldErrors {
  const fieldErrors: Record<string, string> = {};
  if (!(error instanceof ApiError) || error.code !== 'validation_error' || !error.details?.length) {
    return { fieldErrors, fullyMapped: false };
  }
  let mappedCount = 0;
  for (const detail of error.details) {
    const key = FIELD_KEY_BY_PATH[detail.path.join('.')];
    if (key) {
      fieldErrors[key] = detail.message;
      mappedCount += 1;
    }
  }
  return { fieldErrors, fullyMapped: mappedCount === error.details.length };
}
