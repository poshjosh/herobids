import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, auth as authApi } from '../../lib/api-client.js';
import { Button, ErrorBanner, FieldLabel, inputStyle } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

/** Empty name sends `{}` so the server allocates one. */
export function buildCreateAgentRequest(rawName: string): { name?: string } {
  const name = rawName.trim();
  return name ? { name } : {};
}

/** The channel choice is hidden once the profile has a Telegram chat to notify. */
export function shouldShowChannelSection(telegramChatId: string | null | undefined): boolean {
  return !telegramChatId?.trim();
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

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });

  const mutation = useMutation({
    mutationFn: () => agentsApi.create(buildCreateAgentRequest(name)),
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

      {shouldShowChannelSection(meQuery.data?.telegramChatId) && (
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: '8px' }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.channel.title' })}</FieldLabel>
          </legend>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type="radio" name="channel" value="in_app" defaultChecked />
            {intl.formatMessage({ id: 'agents.create.channel.inApp' })}
          </label>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '6px' }}>
            {intl.formatMessage({ id: 'agents.create.channel.help' })}
          </p>
        </fieldset>
      )}

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
