import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClusterCapacitySnapshot } from '../../lib/api-client.js';
import { AdminCapacitySection } from './AdminCapacitySection.js';

function snapshot(overrides: Partial<ClusterCapacitySnapshot> = {}): ClusterCapacitySnapshot {
  return {
    readyAgentNodes: 2,
    maxAgentNodes: 5,
    freeSlots: 6,
    freeMemoryMb: 1800,
    totalMemoryMb: 4096,
    agentMemoryReservationMb: 256,
    agentCpuReservationMhz: 256,
    updatedAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('AdminCapacitySection', () => {
  it('shows a not-reporting message when capacity is null', () => {
    const html = renderToStaticMarkup(<AdminCapacitySection data={{ capacity: null }} />);
    expect(html).toContain('not reporting');
  });

  it('renders nodes, free slots, and free memory when reporting', () => {
    const html = renderToStaticMarkup(<AdminCapacitySection data={{ capacity: snapshot() }} />);
    expect(html).toContain('2 / 5');       // nodes vs max
    expect(html).toContain('Free slots');
    expect(html).toContain('6');            // free slots value
    expect(html).toContain('Free memory');
  });

  it('warns when at the configured node ceiling', () => {
    const html = renderToStaticMarkup(
      <AdminCapacitySection data={{ capacity: snapshot({ readyAgentNodes: 5, maxAgentNodes: 5 }) }} />,
    );
    expect(html).toContain('At the configured node ceiling');
  });

  it('does not warn when below the ceiling', () => {
    const html = renderToStaticMarkup(<AdminCapacitySection data={{ capacity: snapshot() }} />);
    expect(html).not.toContain('At the configured node ceiling');
  });
});
