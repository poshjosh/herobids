import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { setTradingSetupTool } from './trading-setup.js';

function makeCtx(blpopReply: [string, string] | null) {
  const publishToInbound = vi.fn(async () => undefined);
  const blpop = vi.fn(async () => blpopReply);
  const ctx = {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: { blpop } as unknown as ToolContext['redis'],
    publishToInbound,
  } as unknown as ToolContext;
  return { ctx, publishToInbound, blpop };
}

describe('set_trading_setup tool', () => {
  it('rejects a capital that is not a decimal string', async () => {
    const { ctx, publishToInbound } = makeCtx(null);
    const result = await setTradingSetupTool.execute({ capital: 'a lot' }, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('returns a retryable timeout when the broker does not reply', async () => {
    const { ctx } = makeCtx(null);
    const result = await setTradingSetupTool.execute({}, ctx);

    expect(result).toMatchObject({ success: false, retryable: true, errorCode: 'broker.timeout' });
  });

  it('sends the manage_trading_setup message and returns the wallet to fund on success', async () => {
    const reply = JSON.stringify({
      status: 'ok',
      connectionId: 'conn-1',
      provider: 'hyperliquid',
      network: 'Hyperliquid',
      capital: '1000',
      mode: 'paper',
      reused: false,
      walletAddress: '0xWallet',
    });
    const { ctx, publishToInbound, blpop } = makeCtx(['key', reply]);
    const result = await setTradingSetupTool.execute({ capital: '1000' }, ctx);

    expect(publishToInbound).toHaveBeenCalledWith(
      'agent.manage_trading_setup',
      expect.objectContaining({ capital: '1000', requestMessageId: expect.any(String) }),
    );
    expect(blpop).toHaveBeenCalledWith(expect.stringMatching(/^agent:trading-setup:reply:/), 30);
    expect(result).toMatchObject({
      success: true,
      data: { connectionId: 'conn-1', mode: 'paper', walletAddress: '0xWallet' },
    });
  });

  it('returns the plan limit message in plain words without a wallet', async () => {
    const reply = JSON.stringify({
      status: 'error',
      error: 'Your plan allows 5 connections. Remove one or upgrade to continue.',
      errorCode: 'plan.limit',
    });
    const { ctx } = makeCtx(['key', reply]);
    const result = await setTradingSetupTool.execute({}, ctx);

    expect(result).toEqual({
      success: false,
      error: 'Your plan allows 5 connections. Remove one or upgrade to continue.',
      errorCode: 'plan.limit',
      fault: false,
    });
  });
});
