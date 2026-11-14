import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { PageShell, PageHeader } from '../../lib/ui.js';
import type { BlueprintSummary } from '../../lib/api-client.js';
import { BlueprintBrowse } from '../blueprints/BlueprintBrowse.js';
import { BlueprintInstantiateFlow } from '../blueprints/BlueprintInstantiateFlow.js';
import { agentChatPath } from '../agents/agent-chat-path.js';

/** Ready-made agents from the community. Using one creates the agent and opens its chat. */
export function MarketplacePage() {
  const [selectedBlueprint, setSelectedBlueprint] = useState<BlueprintSummary | null>(null);
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Refetch only the agents list (not every ['agents', …] query) before leaving, so the
  // agents page already lists the new agent and opens its chat. The modal stays open,
  // showing "Creating…", until navigation unmounts this page.
  const handleCreated = async (actorId: string) => {
    await qc.refetchQueries({ queryKey: ['agents'], exact: true });
    navigate(agentChatPath(actorId));
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'marketplace.title' })}
        subtitle={intl.formatMessage({ id: 'marketplace.subtitle' })}
      />
      <BlueprintBrowse defaultKind="agent" hideKindFilter onUseBlueprint={setSelectedBlueprint} />
      {selectedBlueprint && (
        <BlueprintInstantiateFlow
          blueprint={selectedBlueprint}
          onClose={() => setSelectedBlueprint(null)}
          onCreated={handleCreated}
        />
      )}
    </PageShell>
  );
}
