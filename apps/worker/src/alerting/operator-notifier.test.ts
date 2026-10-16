import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import { OperatorNotifier } from './operator-notifier.js';

function makeSender(result: 'ok' | 'fail' = 'ok') {
  return {
    sendText: vi.fn().mockResolvedValue(
      result === 'ok' ? ok({ messageId: 1 }) : err({ code: 'telegram.http_error', message: 'down' }),
    ),
  };
}

const report = { agentId: 'agent-1', toolName: 'execute_shell', errorCode: 'execute_shell.sandbox_infrastructure_error' };

describe('OperatorNotifier', () => {
  it('sends the fault report to the operator chat', async () => {
    const sender = makeSender();
    await new OperatorNotifier(sender, 'chat-1', 60_000).reportPlatformFault({ ...report, agentName: 'calm-falcon', summary: 'sandbox broken' });

    expect(sender.sendText).toHaveBeenCalledTimes(1);
    const [chatId, text] = sender.sendText.mock.calls[0] as [string, string];
    expect(chatId).toBe('chat-1');
    expect(text).toContain('calm-falcon');
    expect(text).toContain('execute_shell.sandbox_infrastructure_error');
    expect(text).toContain('sandbox broken');
  });

  it('does not repeat a report for the same agent and error code within the cooldown', async () => {
    const sender = makeSender();
    let now = 1_000;
    const notifier = new OperatorNotifier(sender, 'chat-1', 60_000, () => now);

    await notifier.reportPlatformFault(report);
    now += 30_000;
    await notifier.reportPlatformFault(report);

    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('reports again once the cooldown has passed', async () => {
    const sender = makeSender();
    let now = 1_000;
    const notifier = new OperatorNotifier(sender, 'chat-1', 60_000, () => now);

    await notifier.reportPlatformFault(report);
    now += 60_000;
    await notifier.reportPlatformFault(report);

    expect(sender.sendText).toHaveBeenCalledTimes(2);
  });

  it('reports a different agent or error code independently', async () => {
    const sender = makeSender();
    const notifier = new OperatorNotifier(sender, 'chat-1', 60_000, () => 1_000);

    await notifier.reportPlatformFault(report);
    await notifier.reportPlatformFault({ ...report, agentId: 'agent-2' });
    await notifier.reportPlatformFault({ ...report, errorCode: 'boundary.transport_error' });

    expect(sender.sendText).toHaveBeenCalledTimes(3);
  });

  it('retries on the next fault when sending failed, instead of waiting out the cooldown', async () => {
    const sender = makeSender('fail');
    const notifier = new OperatorNotifier(sender, 'chat-1', 60_000, () => 1_000);

    await notifier.reportPlatformFault(report);
    await notifier.reportPlatformFault(report);

    expect(sender.sendText).toHaveBeenCalledTimes(2);
  });

  it('escapes HTML in agent-controlled text', async () => {
    const sender = makeSender();
    await new OperatorNotifier(sender, 'chat-1', 60_000).reportPlatformFault({ ...report, agentName: '<b>x</b>', summary: '<script>' });

    const text = (sender.sendText.mock.calls[0] as [string, string])[1];
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
