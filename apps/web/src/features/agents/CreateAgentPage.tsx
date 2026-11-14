import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { skills as skillsApi } from '../../lib/api-client.js';
import { PageShell } from '../../lib/ui.js';
import { listSelectableSkills } from './agent-display.js';
import { CreateAgentFlow } from './CreateAgentFlow.js';
import { agentChatPath } from './agent-chat-path.js';

/** Dedicated page for creating a new AI agent. */
export function CreateAgentPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

  // Refetch before leaving, so the agents page already lists the new agent and opens its chat.
  // Refetch only the agents list (not every ['agents', …] query) before leaving, so the
  // agents page already lists the new agent and opens its chat. The create mutation
  // awaits this promise, which keeps the Create button disabled until navigation.
  const handleCreated = async (id: string) => {
    await qc.refetchQueries({ queryKey: ['agents'], exact: true });
    navigate(agentChatPath(id));
  };

  return (
    <PageShell>
      <CreateAgentFlow
        skills={selectableSkills}
        skillsLoading={skillsQuery.isLoading}
        skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
        onClose={() => navigate('/agents')}
        onCreated={handleCreated}
      />
    </PageShell>
  );
}
