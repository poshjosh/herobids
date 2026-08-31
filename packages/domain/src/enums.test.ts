import { describe, it, expect } from 'vitest';
import { DEFAULT_PERMISSION_LEVEL } from './enums.js';

describe('DEFAULT_PERMISSION_LEVEL', () => {
  it('equals "standard"', () => {
    expect(DEFAULT_PERMISSION_LEVEL).toBe('standard');
  });

  it('is one of the valid permission levels', () => {
    const validLevels = ['restricted', 'standard', 'full'];
    expect(validLevels).toContain(DEFAULT_PERMISSION_LEVEL);
  });
});
