import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ProvidersYamlSchema, type ProvidersYaml } from '../models/llm-models.js';

/**
 * Load and validate the provider registry from config/providers.yaml.
 *
 * @throws {ZodError} on schema validation failure
 * @throws {YAMLParseError} on invalid YAML syntax
 * @throws {NodeJS.ErrnoException} on file read errors (e.g., ENOENT)
 */
export function loadProvidersConfig(path: string): ProvidersYaml {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  return ProvidersYamlSchema.parse(parsed);
}
