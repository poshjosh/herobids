import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { AgentActivityDetailFields, AgentActivityTimeline, formatDetailValue } from './AgentActivityTimeline.js';
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

// ---------------------------------------------------------------------------
// detail value formatting — covers the "[object Object]" regression
// (bug 008-activity-feed-payload-object-object)
// ---------------------------------------------------------------------------

describe('formatDetailValue', () => {
  it('renders a plain object as labelled rows, not [object Object]', () => {
    const node = formatDetailValue({ toolName: 'list_positions', status: 'ok' });
    const html = renderToStaticMarkup(<>{node}</>);
    expect(html).toContain('toolName');
    expect(html).toContain('list_positions');
    expect(html).toContain('status');
    expect(html).toContain('ok');
    expect(html).not.toContain('[object Object]');
  });

  it('renders a nested object recursively as labelled rows', () => {
    const node = formatDetailValue({ a: 1, nested: { b: 2 } });
    const html = renderToStaticMarkup(<>{node}</>);
    expect(html).toContain('nested');
    expect(html).toContain('b');
    expect(html).toContain('2');
  });

  it('joins array values as a comma-separated string', () => {
    const result = formatDetailValue([1, 'two', 3]);
    expect(result).toBe('1, two, 3');
  });

  it('renders arrays of objects without falling back to [object Object]', () => {
    const node = formatDetailValue([
      { toolName: 'list_positions', status: 'ok' },
      { toolName: 'get_balance', status: 'error' },
    ]);
    const html = renderToStaticMarkup(<>{node}</>);
    expect(html).toContain('[0]');
    expect(html).toContain('list_positions');
    expect(html).toContain('[1]');
    expect(html).toContain('get_balance');
    expect(html).not.toContain('[object Object]');
  });

  it('preserves string values unchanged', () => {
    expect(formatDetailValue('hello')).toBe('hello');
  });

  it('converts number values to string', () => {
    expect(formatDetailValue(42)).toBe('42');
  });

  it('converts boolean values to string', () => {
    expect(formatDetailValue(true)).toBe('true');
    expect(formatDetailValue(false)).toBe('false');
  });

  it('preserves null as a string', () => {
    expect(formatDetailValue(null)).toBe('null');
  });

  it('preserves undefined as a string', () => {
    expect(formatDetailValue(undefined)).toBe('undefined');
  });

  it('renders finishReason error value in danger colour', () => {
    const node = formatDetailValue('error', 'finishReason');
    const html = renderToStaticMarkup(<>{node}</>);
    expect(html).toContain('var(--color-danger)');
    expect(html).toContain('error');
  });

  it('renders errorMessage value in danger colour', () => {
    const node = formatDetailValue('something went wrong', 'errorMessage');
    const html = renderToStaticMarkup(<>{node}</>);
    expect(html).toContain('var(--color-danger)');
    expect(html).toContain('something went wrong');
  });
});

describe('AgentActivityDetailFields', () => {
  it('renders nested object detail values as labelled rows, not JSON', () => {
    const entryWithObjectDetail: AgentActivityEntry = {
      ...baseEntry,
      id: 'e-obj',
      detail: {
        messageType: 'agent.runtime.tool_result',
        actorType: 'agent',
        payload: { toolName: 'list_positions', status: 'ok', count: 3 },
      },
    };

    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={{}}>
        <div>
          <AgentActivityDetailFields entry={entryWithObjectDetail} />
        </div>
      </IntlProvider>,
    );

    expect(html).toContain('payload');
    expect(html).toContain('toolName');
    expect(html).toContain('list_positions');
    expect(html).toContain('status');
    expect(html).toContain('ok');
    expect(html).toContain('count');
    expect(html).not.toContain('[object Object]');
  });

  it('renders structured detail values without invalid inline block nesting', () => {
    const entryWithObjectDetail: AgentActivityEntry = {
      ...baseEntry,
      id: 'e-inline-block',
      detail: {
        payload: { toolName: 'list_positions', status: 'ok' },
      },
    };

    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={{}}>
        <div>
          <AgentActivityDetailFields entry={entryWithObjectDetail} />
        </div>
      </IntlProvider>,
    );

    expect(html).not.toContain('<span style="word-break:break-all"><div');
  });

  it('renders nullish detail values explicitly', () => {
    const entryWithNullishDetail: AgentActivityEntry = {
      ...baseEntry,
      id: 'e-nullish',
      detail: {
        messageType: 'agent.runtime.tool_result',
        actorType: 'agent',
        payload: null,
        extra: undefined,
      },
    };

    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={{}}>
        <div>
          <AgentActivityDetailFields entry={entryWithNullishDetail} />
        </div>
      </IntlProvider>,
    );

    expect(html).toContain('null');
    expect(html).toContain('undefined');
  });
});
