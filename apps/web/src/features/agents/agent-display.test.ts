import { createIntl, createIntlCache } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { SKILL_PRESET_MAP } from '@herobids/domain';
import { messages } from '../../app/i18n/locales/en.js';
import { formatCapabilityFamily, formatObjectivePreview, resolveCapabilityFamilies } from './agent-display.js';

const intl = createIntl({ locale: 'en', messages }, createIntlCache());

describe('skill preset map and objective preview', () => {
  it('domain SKILL_PRESET_MAP uses personal-assistant as the assistant preset key', () => {
    expect('personal-assistant' in SKILL_PRESET_MAP).toBe(true);
    expect('reminder' in SKILL_PRESET_MAP).toBe(false);
  });

  it('domain SKILL_PRESET_MAP personal-assistant maps to web-access and email', () => {
    expect(SKILL_PRESET_MAP['personal-assistant']).toEqual(['web-access', 'email']);
  });

  it('formats long objectives as a compact preview', () => {
    expect(formatObjectivePreview('Grow my Solana portfolio\nwith disciplined entries and exits', 24)).toBe('Grow my Solana portfoli…');
  });
});

describe('resolveCapabilityFamilies', () => {
  it('returns an empty list when no skills carry capability families', () => {
    expect(resolveCapabilityFamilies([{ capabilityFamilies: [] }, { capabilityFamilies: [] }])).toEqual([]);
  });

  it('deduplicates and sorts families across skills', () => {
    expect(resolveCapabilityFamilies([
      { capabilityFamilies: ['trading'] },
      { capabilityFamilies: ['email'] },
      { capabilityFamilies: ['trading', 'email'] },
    ])).toEqual(['email', 'trading']);
  });

  it('returns a single family for a single-skill agent', () => {
    expect(resolveCapabilityFamilies([{ capabilityFamilies: ['trading'] }])).toEqual(['trading']);
  });
});

describe('formatCapabilityFamily', () => {
  it('labels the email family as "Email"', () => {
    expect(formatCapabilityFamily('email', intl)).toBe('Email');
  });

  it('labels the trading family as "Trading"', () => {
    expect(formatCapabilityFamily('trading', intl)).toBe('Trading');
  });

  it('de-kebabs an unknown family by turning underscores into spaces', () => {
    expect(formatCapabilityFamily('automation_runner', intl)).toBe('automation runner');
  });

  it('de-kebabs an unknown family by turning hyphens into spaces', () => {
    expect(formatCapabilityFamily('messaging-chat', intl)).toBe('messaging chat');
  });

  it('leaves slashes untouched when de-kebabbing an unknown family', () => {
    expect(formatCapabilityFamily('messaging/chat', intl)).toBe('messaging/chat');
  });
});
