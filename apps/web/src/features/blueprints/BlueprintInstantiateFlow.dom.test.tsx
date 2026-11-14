// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blueprints, connections, type BlueprintSummary } from '../../lib/api-client.js';
import { BlueprintInstantiateFlow } from './BlueprintInstantiateFlow.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    blueprints: { ...actual.blueprints, previewInstantiation: vi.fn(), instantiate: vi.fn() },
    connections: { ...actual.connections, list: vi.fn() },
  };
});

const BLUEPRINT = { id: 'bp-1', name: 'Job hunter', kind: 'agent' } as unknown as BlueprintSummary;

const PREVIEW = {
  kind: 'agent',
  revisionId: 'rev-1',
  rawPayload: { name: 'Job hunter' },
  rawRisk: null,
  effectiveRisk: {},
  compatibleExecutionModes: [],
  selectedResolvedMode: null,
  requiredPrivateInputs: [],
  validationWarnings: [],
};

function renderFlow(onCreated?: (actorId: string) => void | Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BlueprintInstantiateFlow blueprint={BLUEPRINT} onClose={() => undefined} onCreated={onCreated} />
    </QueryClientProvider>,
  );
}

async function openConfirmStep() {
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  return screen.getByRole('button', { name: 'Create agent' });
}

describe('BlueprintInstantiateFlow', () => {
  beforeEach(() => {
    vi.mocked(blueprints.previewInstantiation).mockResolvedValue(PREVIEW as never);
    vi.mocked(blueprints.instantiate).mockResolvedValue({ actorId: 'agent-new' } as never);
    vi.mocked(connections.list).mockResolvedValue({ connections: [] } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps Create agent disabled until onCreated settles, so the agent is not created twice', async () => {
    let finishCreated: () => void = () => undefined;
    const onCreated = vi.fn(() => new Promise<void>((resolve) => { finishCreated = resolve; }));
    renderFlow(onCreated);
    const create = await openConfirmStep();

    await act(async () => {
      fireEvent.click(create);
    });
    expect(onCreated).toHaveBeenCalledWith('agent-new');
    const pending = screen.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(blueprints.instantiate).toHaveBeenCalledTimes(1);
    // The flow does not switch to its own success step while the caller is navigating.
    expect(screen.queryByText('Agent created!')).toBeNull();

    await act(async () => { finishCreated(); });
    expect(blueprints.instantiate).toHaveBeenCalledTimes(1);
  });

  it('shows its own success step when no onCreated is given', async () => {
    renderFlow();
    const create = await openConfirmStep();
    await act(async () => {
      fireEvent.click(create);
    });
    expect(await screen.findByText('Agent created!')).toBeTruthy();
  });
});
