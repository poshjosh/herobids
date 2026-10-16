import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, auth as authApi } from '../../lib/api-client.js';
import { Button, ErrorBanner, FieldLabel, inputStyle } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

/** Blank name and chat ID are omitted so the server allocates a name. */
export function buildCreateAgentRequest(
  rawName: string,
  rawTelegramChatId: string,
): { name?: string; telegramChatId?: string } {
  const name = rawName.trim();
  const telegramChatId = rawTelegramChatId.trim();
  return {
    ...(name ? { name } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
  };
}

export function CreateAgentForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });

  const savedTelegramChatId = meQuery.data?.telegramChatId ?? '';
  useEffect(() => {
    setTelegramChatId(savedTelegramChatId);
  }, [savedTelegramChatId]);

  const mutation = useMutation({
    mutationFn: () => agentsApi.create(buildCreateAgentRequest(name, telegramChatId)),
    onSuccess: (agent) => onCreated(agent.id),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}
    >
      <div>
        <FieldLabel htmlFor="create-agent-name">
          {intl.formatMessage({ id: 'agents.create.name' })}{' '}
          <span className="optional-hint">{intl.formatMessage({ id: 'common.optional' })}</span>
        </FieldLabel>
        <input
          id="create-agent-name"
          type="text"
          value={name}
          maxLength={100}
          autoComplete="off"
          placeholder={intl.formatMessage({ id: 'agents.create.nameGenerated' })}
          onChange={(event) => setName(event.target.value)}
          style={{ ...inputStyle, width: '100%' }}
        />
      </div>

      <div>
        <FieldLabel htmlFor="create-agent-telegram-chat-id">
          {intl.formatMessage({ id: 'agents.create.telegramChatId' })}{' '}
          <span className="optional-hint">{intl.formatMessage({ id: 'common.optional' })}</span>
        </FieldLabel>
        <input
          id="create-agent-telegram-chat-id"
          type="text"
          value={telegramChatId}
          autoComplete="off"
          placeholder={intl.formatMessage({ id: 'agents.create.telegramChatId.placeholder' })}
          onChange={(event) => setTelegramChatId(event.target.value)}
          style={{ ...inputStyle, width: '100%' }}
        />
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '6px' }}>
          {intl.formatMessage({ id: 'agents.telegramChatId.help' })}
        </p>
      </div>

      {mutation.isError && (
        <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          {intl.formatMessage({ id: 'common.cancel' })}
        </Button>
        <Button variant="primary" type="submit" disabled={mutation.isPending}>
          {intl.formatMessage({ id: 'agents.createAgent' })}
        </Button>
      </div>
    </form>
  );
}
