import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { Button, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

interface ChildAgentMessageFormProps {
  agentId: string;
  agentName: string;
}

export function ChildAgentMessageForm({ agentId, agentName }: ChildAgentMessageFormProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const trimmedMessage = message.trim();

  const sendMutation = useMutation({
    mutationFn: (text: string) => agentsApi.sendMessage(agentId, text),
    onSuccess: () => {
      setMessage('');
      void qc.invalidateQueries({ queryKey: ['agents', agentId] });
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmedMessage) sendMutation.mutate(trimmedMessage);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      <textarea
        aria-label={intl.formatMessage({ id: 'agents.tree.messagePlaceholder' }, { name: agentName })}
        placeholder={intl.formatMessage({ id: 'agents.tree.messagePlaceholder' }, { name: agentName })}
        value={message}
        rows={2}
        onChange={(event) => setMessage(event.target.value)}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      {sendMutation.isError && (
        <ErrorBanner message={localizeApiError(intl, sendMutation.error, 'common.errorTitle')} />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" size="sm" disabled={!trimmedMessage || sendMutation.isPending}>
          {intl.formatMessage({ id: 'agents.tree.send' })}
        </Button>
      </div>
    </form>
  );
}
