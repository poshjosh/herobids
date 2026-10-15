import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { PageShell, PageHeader } from '../../lib/ui.js';
import { CreateAgentForm } from './CreateAgentForm.js';

/** Dedicated page for creating an AI agent: optional name and channel. */
export function CreateAgentPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const handleCreated = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    navigate(`/agents/${id}`);
  };

  return (
    <PageShell>
      <PageHeader title={intl.formatMessage({ id: 'agents.create.title' })} />
      <CreateAgentForm
        onCancel={() => navigate('/agents')}
        onCreated={handleCreated}
      />
    </PageShell>
  );
}
