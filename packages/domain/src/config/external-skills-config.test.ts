import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppConfigSchema } from './schema.js';

/**
 * Extract the inline externalSkills sub-schema from AppConfigSchema.
 *
 * AppConfigSchema is wrapped with `.superRefine()` (a ZodEffects), so
 * `.shape` is not directly available. We unwrap through `_def.schema`
 * to reach the underlying ZodObject. This is a Zod implementation detail
 * but is stable across Zod 3.x and is the standard approach for testing
 * nested inline sub-schemas without modifying the production module.
 */
function extractExternalSkillsSchema(): z.ZodDefault<z.ZodObject<z.ZodRawShape>> {
  const def = (AppConfigSchema as unknown as { _def: { schema?: z.ZodObject<z.ZodRawShape> } })._def;
  if (!def.schema?.shape?.externalSkills) {
    throw new Error(
      'Could not extract externalSkills sub-schema from AppConfigSchema — has the schema structure changed?',
    );
  }
  return def.schema.shape.externalSkills as z.ZodDefault<z.ZodObject<z.ZodRawShape>>;
}

const ExternalSkillsSchema = extractExternalSkillsSchema();

describe('ExternalSkillsConfigSchema', () => {
  // ── Defaults ────────────────────────────────────────────────────────────

  describe('defaults', () => {
    it('applies all defaults when externalSkills is omitted (empty object)', () => {
      const result = ExternalSkillsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.apiBaseUrl).toBe('http://skills-api:3456');
        expect(result.data.searchApiBaseUrl).toBe('https://skills.sh');
        expect(result.data.searchTimeoutMs).toBe(10000);
        expect(result.data.browseTimeoutMs).toBe(5000);
        expect(result.data.statsTimeoutMs).toBe(3000);
      }
    });

    it('applies individual field defaults when only some fields are provided', () => {
      const result = ExternalSkillsSchema.safeParse({ enabled: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.apiBaseUrl).toBe('http://skills-api:3456');
        expect(result.data.searchApiBaseUrl).toBe('https://skills.sh');
        expect(result.data.searchTimeoutMs).toBe(10000);
        expect(result.data.browseTimeoutMs).toBe(5000);
        expect(result.data.statsTimeoutMs).toBe(3000);
      }
    });
  });

  // ── Custom values ───────────────────────────────────────────────────────

  describe('custom values', () => {
    it('accepts valid custom values for all fields', () => {
      const result = ExternalSkillsSchema.safeParse({
        enabled: false,
        apiBaseUrl: 'https://skills.example.com',
        searchApiBaseUrl: 'https://custom-search.example.com',
        searchTimeoutMs: 10000,
        browseTimeoutMs: 15000,
        statsTimeoutMs: 8000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.apiBaseUrl).toBe('https://skills.example.com');
        expect(result.data.searchApiBaseUrl).toBe('https://custom-search.example.com');
        expect(result.data.searchTimeoutMs).toBe(10000);
        expect(result.data.browseTimeoutMs).toBe(15000);
        expect(result.data.statsTimeoutMs).toBe(8000);
      }
    });

    it('accepts boundary-minimum timeout values', () => {
      const result = ExternalSkillsSchema.safeParse({
        searchTimeoutMs: 500,
        browseTimeoutMs: 500,
        statsTimeoutMs: 500,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchTimeoutMs).toBe(500);
        expect(result.data.browseTimeoutMs).toBe(500);
        expect(result.data.statsTimeoutMs).toBe(500);
      }
    });

    it('accepts boundary-maximum timeout values', () => {
      const result = ExternalSkillsSchema.safeParse({
        searchTimeoutMs: 30000,
        browseTimeoutMs: 30000,
        statsTimeoutMs: 10000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.searchTimeoutMs).toBe(30000);
        expect(result.data.browseTimeoutMs).toBe(30000);
        expect(result.data.statsTimeoutMs).toBe(10000);
      }
    });
  });

  // ── Validation failures ─────────────────────────────────────────────────

  describe('validation failures', () => {
    it('rejects invalid URL for apiBaseUrl', () => {
      const result = ExternalSkillsSchema.safeParse({
        apiBaseUrl: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string for apiBaseUrl', () => {
      const result = ExternalSkillsSchema.safeParse({
        apiBaseUrl: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid URL for searchApiBaseUrl', () => {
      const result = ExternalSkillsSchema.safeParse({
        searchApiBaseUrl: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string for searchApiBaseUrl', () => {
      const result = ExternalSkillsSchema.safeParse({
        searchApiBaseUrl: '',
      });
      expect(result.success).toBe(false);
    });

    // ── searchTimeoutMs ─────────────────────────────────────────────────

    it('rejects searchTimeoutMs below minimum (499)', () => {
      const result = ExternalSkillsSchema.safeParse({ searchTimeoutMs: 499 });
      expect(result.success).toBe(false);
    });

    it('rejects searchTimeoutMs above maximum (30001)', () => {
      const result = ExternalSkillsSchema.safeParse({ searchTimeoutMs: 30001 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer searchTimeoutMs', () => {
      const result = ExternalSkillsSchema.safeParse({ searchTimeoutMs: 5000.5 });
      expect(result.success).toBe(false);
    });

    // ── browseTimeoutMs ─────────────────────────────────────────────────

    it('rejects browseTimeoutMs below minimum (499)', () => {
      const result = ExternalSkillsSchema.safeParse({ browseTimeoutMs: 499 });
      expect(result.success).toBe(false);
    });

    it('rejects browseTimeoutMs above maximum (30001)', () => {
      const result = ExternalSkillsSchema.safeParse({ browseTimeoutMs: 30001 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer browseTimeoutMs', () => {
      const result = ExternalSkillsSchema.safeParse({ browseTimeoutMs: 5000.5 });
      expect(result.success).toBe(false);
    });

    // ── statsTimeoutMs ──────────────────────────────────────────────────

    it('rejects statsTimeoutMs below minimum (499)', () => {
      const result = ExternalSkillsSchema.safeParse({ statsTimeoutMs: 499 });
      expect(result.success).toBe(false);
    });

    it('rejects statsTimeoutMs above maximum (10001)', () => {
      const result = ExternalSkillsSchema.safeParse({ statsTimeoutMs: 10001 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer statsTimeoutMs', () => {
      const result = ExternalSkillsSchema.safeParse({ statsTimeoutMs: 3000.7 });
      expect(result.success).toBe(false);
    });

    // ── enabled type check ──────────────────────────────────────────────

    it('rejects non-boolean enabled value', () => {
      const result = ExternalSkillsSchema.safeParse({ enabled: 'yes' });
      expect(result.success).toBe(false);
    });

    // ── timeout type checks ─────────────────────────────────────────────

    it('rejects string timeout values', () => {
      const result = ExternalSkillsSchema.safeParse({ searchTimeoutMs: '5000' });
      expect(result.success).toBe(false);
    });

    // ── zero and negative values ────────────────────────────────────────

    it('rejects zero searchTimeoutMs', () => {
      const result = ExternalSkillsSchema.safeParse({ searchTimeoutMs: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects negative browseTimeoutMs', () => {
      const result = ExternalSkillsSchema.safeParse({ browseTimeoutMs: -1 });
      expect(result.success).toBe(false);
    });
  });
});
