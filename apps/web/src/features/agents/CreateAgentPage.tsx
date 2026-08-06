import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { skills as skillsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader } from '../../lib/ui.js';
import { GuidedSetupPanel } from '../chat/GuidedSetupPanel.js';
import { listSelectableSkills } from './agent-display.js';
import { CreateAgentFlow } from './AgentsPage.js';

/**
 * Dedicated page for creating a new AI agent.
 *
 * Hosts both the guided (chat) and plain (form) creation flows, with a header
 * toggle to switch between them. Kept separate from the agents list page so the
 * creation experience is focused and free of layout overlap.
 */
export function CreateAgentPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'guided' | 'form'>('guided');
  const guidedStartOverRef = useRef<(() => void) | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

  const handleCreated = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    navigate(`/agents/${id}`);
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.create.title' })}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="create-flow-switch"
              onClick={() => setMode(mode === 'guided' ? 'form' : 'guided')}
            >
              {mode === 'guided'
                ? intl.formatMessage({ id: 'agents.create.switchToForm' })
                : intl.formatMessage({ id: 'agents.create.switchToGuided' })}
            </button>
            {mode === 'guided' && (
              <button
                type="button"
                className="create-flow-refresh"
                title={intl.formatMessage({ id: 'agents.create.refresh' })}
                aria-label={intl.formatMessage({ id: 'agents.create.refresh' })}
                onClick={() => guidedStartOverRef.current?.()}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              </button>
            )}
          </div>
        }
      />

      {mode === 'guided' ? (
        <GuidedSetupPanel
          startOverRef={guidedStartOverRef}
          onAgentCreated={handleCreated}
          onSwitchToForm={() => setMode('form')}
        />
      ) : (
        <CreateAgentFlow
          skills={selectableSkills}
          skillsLoading={skillsQuery.isLoading}
          skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
          onClose={() => navigate('/agents')}
          onCreated={handleCreated}
        />
      )}
    </PageShell>
  );
}
