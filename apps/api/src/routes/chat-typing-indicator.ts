import { z } from 'zod';
import { chatTypingStopKey, err, ok, type ChatAddress, type ChatChannel, type ChatProvider, type DomainError, type Result } from '@herobids/domain';

export type ChatTypingSenders = Map<ChatProvider, Pick<ChatChannel, 'sendTyping'>>;

export interface ChatTypingTiming {
  refreshIntervalMs: number;
  maxWindowMs: number;
}

/** The slice of Redis the typing loop uses; Redis satisfies it structurally. */
export interface ChatTypingStopStore {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface ChatTypingLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

/** Bounds a sendChatAction call so a hung request cannot pile up behind the refresh interval. */
const TELEGRAM_TYPING_REQUEST_TIMEOUT_MS = 3000;
/** Bounds the stop-signal GET so a hung Redis read cannot stall a refresh tick. */
const TYPING_STOP_CHECK_TIMEOUT_MS = 1000;
const STOP_CHECK_TIMED_OUT = Symbol('typing-stop-check-timed-out');

interface ActiveTyping {
  refresh: ReturnType<typeof setInterval>;
  expire: ReturnType<typeof setTimeout>;
}

/**
 * Shows a provider's typing indicator while an agent works on a user message.
 * Sends immediately, refreshes on an interval, and stops when the window elapses
 * or the worker's reply stop signal (see chatTypingStopKey) is present.
 * A new message to the same chat restarts the window. Failures are logged and ignored.
 */
export class ChatTypingIndicator {
  private readonly refreshers = new Map<string, ActiveTyping>();
  private disposed = false;

  constructor(
    private readonly senders: ChatTypingSenders,
    private readonly timing: ChatTypingTiming,
    private readonly redis: ChatTypingStopStore,
    private readonly logger?: ChatTypingLogger,
  ) {}

  start(address: ChatAddress): void {
    if (this.disposed) return;
    const sender = this.senders.get(address.provider);
    if (!sender?.sendTyping) return;

    const key = `${address.provider}:${address.address}`;
    this.stop(address);
    // A stop signal left by an earlier reply must not end this session. The DEL is queued
    // before the first refresh tick's GET, and commands on one Redis connection run in order.
    void this.clearStop(address);
    const sendTyping = sender.sendTyping.bind(sender);
    void this.sendOnce(address, sendTyping);
    const active: ActiveTyping = {
      refresh: setInterval(() => { void this.refreshIfActive(key, address, active, sendTyping); }, this.timing.refreshIntervalMs).unref(),
      expire: setTimeout(() => this.stop(address), this.timing.maxWindowMs).unref(),
    };
    this.refreshers.set(key, active);
  }

  stop(address: ChatAddress): void {
    const key = `${address.provider}:${address.address}`;
    const active = this.refreshers.get(key);
    if (!active) return;
    clearInterval(active.refresh);
    clearTimeout(active.expire);
    this.refreshers.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const active of this.refreshers.values()) {
      clearInterval(active.refresh);
      clearTimeout(active.expire);
    }
    this.refreshers.clear();
  }

  /** Stop-signal check runs at the same point as the window check: each refresh tick, before any typing action. */
  private async refreshIfActive(
    key: string,
    address: ChatAddress,
    active: ActiveTyping,
    sendTyping: (to: ChatAddress) => Promise<Result<void, DomainError>>,
  ): Promise<void> {
    const stopped = await this.isStopped(address);
    // The session may have expired, been disposed, or been replaced while the check was in flight.
    if (this.refreshers.get(key) !== active) return;
    if (stopped) {
      this.stop(address);
      return;
    }
    await this.sendOnce(address, sendTyping);
  }

  /** A failed or timed-out check counts as not stopped, so a Redis outage never silences typing. */
  private async isStopped(address: ChatAddress): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof STOP_CHECK_TIMED_OUT>((resolve) => {
      timer = setTimeout(resolve, TYPING_STOP_CHECK_TIMEOUT_MS, STOP_CHECK_TIMED_OUT);
    });
    try {
      const value = await Promise.race([this.redis.get(chatTypingStopKey(address)), timeout]);
      if (value === STOP_CHECK_TIMED_OUT) {
        this.logger?.warn({ provider: address.provider }, 'Typing stop check timed out');
        return false;
      }
      return value !== null;
    } catch (error) {
      this.logger?.warn({ provider: address.provider, error: error instanceof Error ? error.message : String(error) }, 'Typing stop check failed');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async clearStop(address: ChatAddress): Promise<void> {
    try {
      await this.redis.del(chatTypingStopKey(address));
    } catch (error) {
      this.logger?.warn({ provider: address.provider, error: error instanceof Error ? error.message : String(error) }, 'Typing stop reset failed');
    }
  }

  private async sendOnce(address: ChatAddress, sendTyping: (to: ChatAddress) => Promise<Result<void, DomainError>>): Promise<void> {
    try {
      const result = await sendTyping(address);
      if (!result.ok) this.logger?.warn({ provider: address.provider, code: result.error.code }, 'Typing indicator failed');
    } catch (error) {
      this.logger?.warn({ provider: address.provider, error: error instanceof Error ? error.message : String(error) }, 'Typing indicator failed');
    }
  }
}

const TelegramChatActionResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
});

/** Telegram sendChatAction with the typing action. Mirrors the sendTelegramText fetch in agent-interactivity. */
export function createTelegramTypingSender(botToken: string): { sendTyping(to: ChatAddress): Promise<Result<void, DomainError>> } {
  return {
    async sendTyping(to: ChatAddress): Promise<Result<void, DomainError>> {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: to.address, action: 'typing' }),
          signal: AbortSignal.timeout(TELEGRAM_TYPING_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return err({ code: 'telegram.http_error', message: `HTTP ${response.status}` });

        const data = TelegramChatActionResponseSchema.safeParse(await response.json());
        if (!data.success) return err({ code: 'telegram.invalid_response', message: 'Invalid Telegram response' });
        if (!data.data.ok) return err({ code: 'telegram.api_error', message: data.data.description ?? 'Unknown Telegram API error' });
        return ok(undefined);
      } catch (error) {
        return err({ code: 'telegram.network_error', message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
