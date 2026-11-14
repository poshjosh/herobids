import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminServersResponse, ServerHealthSnapshot } from '../../lib/api-client.js';
import { AdminServersSection } from './AdminServersSection.js';

function server(overrides: Partial<ServerHealthSnapshot>): ServerHealthSnapshot {
  return {
    serverType: 'agent-server',
    serverId: 'agent-1',
    hostname: 'agent-1',
    memory: { totalBytes: 1000, usedBytes: 0, freeBytes: 1000 },
    disk: null,
    cpuPct: null,
    loadAvg: [0, 0, 0],
    uptimeSeconds: 0,
    version: '1.0.0',
    updatedAt: '2026-11-14T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function grouped(servers: ServerHealthSnapshot[]): AdminServersResponse {
  const byType: Record<string, ServerHealthSnapshot[]> = {};
  for (const s of servers) (byType[s.serverType] ??= []).push(s);
  return { servers: byType };
}

describe('AdminServersSection — agent-server card', () => {
  it('does not render "Up 0m" for an agent-server node (uptime is unavailable)', () => {
    const html = renderToStaticMarkup(
      <AdminServersSection data={grouped([server({ metadata: { nomadAllocations: 3 } })])} />,
    );
    expect(html).not.toContain('Up 0m');
  });

  it('shows the allocation count on the agent-server card', () => {
    const html = renderToStaticMarkup(
      <AdminServersSection data={grouped([server({ metadata: { nomadAllocations: 3 } })])} />,
    );
    expect(html).toContain('Allocations');
    expect(html).toContain('3');
  });
});

describe('AdminServersSection — browser-pool saturation', () => {
  it('shows the "At capacity" badge for a saturated browser node', () => {
    const bp = server({
      serverType: 'browser-pool',
      serverId: 'bp-1',
      hostname: 'bp-1',
      metadata: { activeSessions: 10, maxConcurrentSessions: 10, isAvailable: true },
    });
    const html = renderToStaticMarkup(<AdminServersSection data={grouped([bp])} />);
    expect(html).toContain('At capacity');
  });

  it('does not show the badge for an idle browser node', () => {
    const bp = server({
      serverType: 'browser-pool',
      serverId: 'bp-2',
      hostname: 'bp-2',
      metadata: { activeSessions: 1, maxConcurrentSessions: 10, isAvailable: true },
    });
    const html = renderToStaticMarkup(<AdminServersSection data={grouped([bp])} />);
    expect(html).not.toContain('At capacity');
  });
});
