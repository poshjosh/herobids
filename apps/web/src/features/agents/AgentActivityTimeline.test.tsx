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
  it('serializes a plain object to JSON, not [object Object]', () => {
    const result = formatDetailValue({ toolName: 'list_positions', status: 'ok' });
    expect(result).toBe('{"toolName":"list_positions","status":"ok"}');
    expect(result).not.toBe('[object Object]');
  });

  it('serializes a nested object to JSON', () => {
    const result = formatDetailValue({ a: 1, nested: { b: 2 } });
    expect(result).toBe('{"a":1,"nested":{"b":2}}');
  });

  it('serializes an array to JSON', () => {
    const result = formatDetailValue([1, 'two', 3]);
    expect(result).toBe('[1,"two",3]');
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
});

describe('AgentActivityDetailFields', () => {
  it('renders the expanded detail view with object payloads serialized as JSON', () => {
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
    expect(html).toContain('{&quot;toolName&quot;:&quot;list_positions&quot;,&quot;status&quot;:&quot;ok&quot;,&quot;count&quot;:3}');
    expect(html).not.toContain('[object Object]');
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
