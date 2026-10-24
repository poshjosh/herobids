import { describe, expect, it, vi } from 'vitest';
import { DecisionApprovalRepository } from './decision-approval-repository.js';

function buildStatusUpdateDb() {
  const returningFn = vi.fn().mockResolvedValue([{ id: 'appr-1' }]);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { db: { update: updateFn }, setFn };
}

describe('DecisionApprovalRepository.updateStatus', () => {
  it('records the telegram resolution provider alongside the legacy telegram_yes source', async () => {
    const { db, setFn } = buildStatusUpdateDb();
    const repo = new DecisionApprovalRepository(db as never);

    await repo.updateStatus('appr-1', 'approved', {
      resolvedByUserId: 'user-1',
      resolutionSource: 'telegram_yes',
      resolutionProvider: 'telegram',
    });

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      resolutionSource: 'telegram_yes',
      resolutionProvider: 'telegram',
    }));
  });

  it('leaves the resolution provider empty for web resolutions that name no chat provider', async () => {
    const { db, setFn } = buildStatusUpdateDb();
    const repo = new DecisionApprovalRepository(db as never);

    await repo.updateStatus('appr-1', 'rejected', {
      resolvedByUserId: 'user-1',
      resolutionSource: 'web',
    });

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      resolutionSource: 'web',
      resolutionProvider: null,
    }));
  });
});
