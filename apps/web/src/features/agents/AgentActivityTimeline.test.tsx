import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { AgentActivityTimeline } from './AgentActivityTimeline.js';
import type { AgentActivityEntry } from '../../lib/api-client.js';

function renderTimeline(entries: AgentActivityEntry[], isLoading = false, isEmpty = false): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={{}}>
      <AgentActivityTimeline entries={entries} isLoading={isLoading} isEmpty={isEmpty} />
    </IntlProvider>,
  );
}

const baseEntry: AgentActivityEntry = {
  id: 'entry-1',
  agentId: 'agent-1',
  timestamp: '2026-06-11T12:03:42.000Z',
  category: 'decision',
  severity: 'warn',
  eventType: 'decision.rejected',
  title: 'Decision rejected',
  summary: 'Proposed entry was blocked by risk validation.',
  detail: { errorCode: 'risk.exceeded' },
  sessionId: 'sess-1',
  direction: 'outbound',
  processingStatus: 'rejected',
  correlationId: 'corr-1',
  traceId: null,
};

describe('AgentActivityTimeline', () => {
  it('renders loading state', () => {
    const html = renderTimeline([], true, false);
    expect(html).toContain('Loading');
  });

  it('renders empty state', () => {
    const html = renderTimeline([], false, true);
    expect(html).toContain('No activity recorded yet');
  });

  it('renders a timeline entry with title and summary', () => {
    const html = renderTimeline([baseEntry]);
    expect(html).toContain('Decision rejected');
    expect(html).toContain('Proposed entry was blocked by risk validation.');
  });

  it('renders category icon for decision', () => {
    const html = renderTimeline([baseEntry]);
    // Decision icon is ◈
    expect(html).toContain('◈');
  });

  it('renders multiple entries in order', () => {
    const entries: AgentActivityEntry[] = [
      { ...baseEntry, id: 'e1', title: 'Session started', category: 'runtime', severity: 'info', eventType: 'runtime.started' },
      { ...baseEntry, id: 'e2', title: 'Context updated', category: 'tick', severity: 'info', eventType: 'system.alert' },
      { ...baseEntry, id: 'e3', title: 'Decision rejected', category: 'decision', severity: 'warn', eventType: 'decision.rejected' },
    ];
    const html = renderTimeline(entries);
    const sessionIdx = html.indexOf('Session started');
    const tickIdx = html.indexOf('Context updated');
    const decisionIdx = html.indexOf('Decision rejected');
    expect(sessionIdx).toBeLessThan(tickIdx);
    expect(tickIdx).toBeLessThan(decisionIdx);
  });

  it('renders runtime icon for runtime events', () => {
    const runtimeEntry: AgentActivityEntry = {
      ...baseEntry,
      id: 'e-rt',
      category: 'runtime',
      eventType: 'runtime.failed',
      severity: 'critical',
      title: 'Runtime crashed',
    };
    const html = renderTimeline([runtimeEntry]);
    expect(html).toContain('⟳');
  });

  it('renders tool icon for tool events', () => {
    const toolEntry: AgentActivityEntry = {
      ...baseEntry,
      id: 'e-tool',
      category: 'tool',
      eventType: 'system.alert',
      severity: 'info',
      title: 'Tool result',
    };
    const html = renderTimeline([toolEntry]);
    expect(html).toContain('⚙');
  });
});
