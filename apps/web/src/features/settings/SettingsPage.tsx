import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { auth as authApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, Button, FieldLabel, ErrorBanner } from '../../lib/ui.js';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  background: 'var(--color-surface-2)',
  color: 'var(--color-text)',
  fontSize: '14px',
  boxSizing: 'border-box',
};

export function SettingsPage() {
  const qc = useQueryClient();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });

  const [telegramChatId, setTelegramChatId] = useState<string>('');
  const [saved, setSaved] = useState(false);

  // Hydrate form from fetched data once. Runs again when data changes after a
  // successful save (query invalidation), but not while the user is typing
  // because the mutation's onSuccess invalidation only fires after a round-trip.
  useEffect(() => {
    if (meQuery.data) {
      setTelegramChatId(meQuery.data.telegramChatId ?? '');
    }
  }, [meQuery.data]);

  const telegramMutation = useMutation({
    mutationFn: (chatId: string) => authApi.updateMe({ telegramChatId: chatId.trim() || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  return (
    <PageShell>
      <PageHeader title="Settings" subtitle="Account preferences and notification configuration" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '540px' }}>
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Telegram Notifications</h3>
          <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            Bind your Telegram account to receive agent messages and safety alerts directly in Telegram.
            Start a chat with the Herobids bot, send <code>/start</code>, then paste your chat ID here.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              telegramMutation.mutate(telegramChatId);
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            {telegramMutation.isError && (
              <ErrorBanner message={(telegramMutation.error as Error).message} />
            )}
            {saved && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--color-success-subtle)', color: 'var(--color-success)', fontSize: '13px' }}>
                Telegram chat ID saved.
              </div>
            )}

            <div>
              <FieldLabel>Telegram Chat ID</FieldLabel>
              <input
                style={inputStyle}
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder="e.g. 123456789"
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Button variant="primary" type="submit" disabled={telegramMutation.isPending || telegramChatId.trim() === (meQuery.data?.telegramChatId ?? '')}>
                {telegramMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
              {telegramChatId && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setTelegramChatId('');
                    telegramMutation.mutate('');
                  }}
                  disabled={telegramMutation.isPending}
                >
                  Remove
                </Button>
              )}
            </div>
          </form>
        </Card>
      </div>
    </PageShell>
  );
}
