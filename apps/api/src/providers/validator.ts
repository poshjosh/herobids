import type { RegistryEntry, RegistryFieldDefinition, ValidationErrorDefinition } from './types.js';

export interface ProviderValidationError {
  field: string;
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

function normalizeSecretToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function applyNormalizationRules(value: string, rules: readonly ('trim' | 'lowercase' | 'uppercase')[] | undefined): string {
  let normalized = value;
  for (const rule of rules ?? ['trim']) {
    if (rule === 'trim') {
      normalized = normalized.trim();
    } else if (rule === 'lowercase') {
      normalized = normalized.toLowerCase();
    } else if (rule === 'uppercase') {
      normalized = normalized.toUpperCase();
    }
  }
  return normalized;
}

function findFieldByCanonicalKey(entry: RegistryEntry, key: string): RegistryFieldDefinition | undefined {
  return entry.credentials?.fields.find((field) => field.key === key);
}

function getValidationError(
  field: RegistryFieldDefinition,
  kind: keyof NonNullable<RegistryFieldDefinition['errors']>,
  fallback: ValidationErrorDefinition,
): ValidationErrorDefinition {
  return field.errors?.[kind] ?? fallback;
}

export function canonicalizeProviderSecrets(_venue: string, secrets: Record<string, string>, entry?: RegistryEntry): Record<string, string> {
  const aliasMap = new Map<string, string>();
  for (const field of entry?.credentials?.fields ?? []) {
    aliasMap.set(normalizeSecretToken(field.key), field.key);
    for (const alias of field.aliases) {
      aliasMap.set(normalizeSecretToken(alias), field.key);
    }
  }

  const canonicalSecrets: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(secrets)) {
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) {
      continue;
    }

    const canonicalKey = aliasMap.get(normalizeSecretToken(trimmedKey)) ?? trimmedKey;
    const field = entry ? findFieldByCanonicalKey(entry, canonicalKey) : undefined;
    canonicalSecrets[canonicalKey] = applyNormalizationRules(rawValue, field?.normalization);
  }

  return canonicalSecrets;
}

export function validateProviderSecrets(venue: string, secrets: Record<string, string>, entry?: RegistryEntry): ProviderValidationError[] {
  if (!entry?.credentials) {
    return [];
  }

  const errors: ProviderValidationError[] = [];
  for (const field of entry.credentials.fields) {
    const value = secrets[field.key] ?? '';
    const params = { field: field.key, venue };

    if (field.required && value.trim().length === 0) {
      const error = getValidationError(field, 'required', {
        code: 'credential.validation_error.required',
        message: `${field.key} is required for ${venue} credentials`,
      });
      errors.push({ field: `secrets.${field.key}`, code: error.code, message: error.message, params });
      continue;
    }

    if (value.length === 0) {
      continue;
    }

    if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) {
      const error = getValidationError(field, 'minLength', {
        code: 'credential.validation_error.min_length',
        message: `${field.key} is too short for ${venue} credentials`,
      });
      errors.push({ field: `secrets.${field.key}`, code: error.code, message: error.message, params });
    }

    if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
      const error = getValidationError(field, 'maxLength', {
        code: 'credential.validation_error.max_length',
        message: `${field.key} is too long for ${venue} credentials`,
      });
      errors.push({ field: `secrets.${field.key}`, code: error.code, message: error.message, params });
    }

    if (field.validation?.pattern !== undefined && !new RegExp(field.validation.pattern).test(value)) {
      const error = getValidationError(field, 'pattern', {
        code: 'credential.validation_error.invalid_format',
        message: `${field.key} has an invalid format for ${venue} credentials`,
      });
      errors.push({ field: `secrets.${field.key}`, code: error.code, message: error.message, params });
    }
  }

  return errors;
}