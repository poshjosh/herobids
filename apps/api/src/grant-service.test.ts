import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((left, right) => ({ left, right })),
    and: vi.fn((...args) => ({ args })),
    inArray: vi.fn((left, right) => ({ left, right })),
  };
});

import { eq, inArray } from 'drizzle-orm';
import { capabilityGrantAudit, capabilityGrants } from '@herobids/db';
import { getBindingAudit } from './grant-service.js';

function makeDb(auditRows: unknown[]) {
  let selectCount = 0;

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCount += 1;
          if (selectCount === 1) {
            return Promise.resolve([{ id: 'grant-1' }]);
          }
          return {
            orderBy: vi.fn().mockResolvedValue(auditRows),
          };
        }),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBindingAudit', () => {
  it('scopes audit lookup to the agent and binding', async () => {
    const auditRows = [{ id: 'audit-1' }, { id: 'audit-2' }];
    const db = makeDb(auditRows);

    const rows = await getBindingAudit(db as never, 'binding-1', 'agent-1');

    expect(rows).toEqual(auditRows);
    expect(eq).toHaveBeenCalledWith(capabilityGrants.bindingId, 'binding-1');
    expect(eq).toHaveBeenCalledWith(capabilityGrants.agentId, 'agent-1');
    expect(inArray).toHaveBeenCalledWith(capabilityGrantAudit.grantId, ['grant-1']);
  });
});