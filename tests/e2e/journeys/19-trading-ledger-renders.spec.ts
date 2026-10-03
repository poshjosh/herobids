/**
 * Journey 19: the trading capability ledger renders a P&L summary, a Trades
 * table (open + closed rows with signed, colour-coded P&L), and collapsed
 * Decisions / Fills history that expand on click.
 *
 * The `/presentation` endpoint is stubbed with a deterministic fixture (one
 * winning closed trade, one losing closed trade, one open trade) so the
 * assertions do not depend on live market data or a seeded database. Readiness
 * is mocked ready via `mockTradingReadiness` so the capability page mounts the
 * presentation. The spec degrades gracefully (skips) when the auth token or an
 * expected theme token is unavailable in the running build, mirroring journey 8.
 */

import { test, expect, type Page } from '@playwright/test';
import { registerUser, createAgent, mockTradingReadiness } from '../helpers.js';

const EMAIL = `j19-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword19!';
const CONNECTION_ID = 'conn-j19';

const WHEN_OPEN = '2026-10-03T10:00:00.000Z';
const WHEN_WIN = '2026-10-02T10:00:00.000Z';
const WHEN_LOSS = '2026-10-01T10:00:00.000Z';

function presentationFixture(connectionId: string) {
  const column = (key: string, labelKey: string, align: 'start' | 'end', format: 'text' | 'timestamp') => ({
    key,
    label: key,
    labelKey,
    align,
    format,
  });

  return {
    family: 'trading',
    connection: { id: connectionId, label: 'Hyperliquid', state: 'ready' },
    attributes: [
      { key: 'total-pnl', label: 'Total profit / loss', labelKey: 'capability.trading.attr.totalPnl', value: '-7.66', emphasis: 'negative', prominence: 'primary' },
      { key: 'realized-pnl', label: 'From closed trades', labelKey: 'capability.trading.attr.realizedPnl', value: '-7.66', emphasis: 'negative', prominence: 'primary' },
      { key: 'unrealized-pnl', label: 'From open trades', labelKey: 'capability.trading.attr.unrealizedPnl', value: '+0.00', emphasis: 'neutral', prominence: 'primary' },
      { key: 'winning-trades', label: 'Winning trades', labelKey: 'capability.trading.attr.winningTrades', value: '1 of 2', valueKey: 'capability.trading.value.winsOfClosed', valueParams: { wins: '1', closed: '2' }, prominence: 'primary' },
      { key: 'connection', label: 'Connection', labelKey: 'capability.trading.attr.connection', value: 'Hyperliquid', prominence: 'secondary' },
    ],
    feeds: [
      {
        key: 'trades',
        label: 'Trades',
        labelKey: 'capability.trading.feed.trades',
        prominence: 'primary',
        columns: [
          column('when', 'capability.trading.col.when', 'start', 'timestamp'),
          column('asset', 'capability.trading.col.asset', 'start', 'text'),
          column('status', 'capability.trading.col.status', 'start', 'text'),
          column('pnl', 'capability.trading.col.pnl', 'end', 'text'),
        ],
        items: [
          {
            id: 'open-row',
            title: 'BTC',
            occurredAt: WHEN_OPEN,
            cells: {
              when: { value: WHEN_OPEN },
              asset: { value: 'BTC' },
              status: { value: 'Open', valueKey: 'capability.trading.value.open' },
              pnl: { value: '—', emphasis: 'neutral' },
            },
          },
          {
            id: 'win-row',
            title: 'ETH',
            occurredAt: WHEN_WIN,
            cells: {
              when: { value: WHEN_WIN },
              asset: { value: 'ETH' },
              status: { value: 'Closed', valueKey: 'capability.trading.value.closed' },
              pnl: { value: '+12.34', emphasis: 'positive' },
            },
          },
          {
            id: 'loss-row',
            title: 'SOL',
            occurredAt: WHEN_LOSS,
            cells: {
              when: { value: WHEN_LOSS },
              asset: { value: 'SOL' },
              status: { value: 'Closed', valueKey: 'capability.trading.value.closed' },
              pnl: { value: '-20.00', emphasis: 'negative' },
            },
          },
        ],
      },
      {
        key: 'decisions',
        label: 'Decisions',
        labelKey: 'capability.trading.feed.decisions',
        prominence: 'secondary',
        items: [
          {
            id: 'decision-1',
            title: 'go long',
            titleKey: 'capability.trading.intent.go_long',
            detail: 'BTC',
            occurredAt: WHEN_OPEN,
            badge: { value: 'Done', valueKey: 'capability.trading.decisionStatus.completed', emphasis: 'neutral' },
          },
        ],
      },
      {
        key: 'fills',
        label: 'Fills',
        labelKey: 'capability.trading.feed.fills',
        prominence: 'secondary',
        columns: [
          column('when', 'capability.trading.col.when', 'start', 'timestamp'),
          column('asset', 'capability.trading.col.asset', 'start', 'text'),
          column('side', 'capability.trading.col.side', 'start', 'text'),
        ],
        items: [
          {
            id: 'fill-1',
            title: 'ETH',
            occurredAt: WHEN_WIN,
            cells: {
              when: { value: WHEN_WIN },
              asset: { value: 'ETH' },
              side: { value: 'Sell', valueKey: 'capability.trading.value.sell' },
            },
          },
        ],
      },
    ],
  };
}

/** Resolve the CSS colour the renderer applies for the given emphasis token. */
async function tokenColor(page: Page, token: string): Promise<string | null> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    // An unresolved CSS var leaves the colour empty / inherited.
    return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : null;
  }, token);
}

test.describe('Journey 19: trading capability ledger renders', () => {
  test('shows P&L tiles, a signed/coloured Trades table, and collapsed history that expands', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J19');

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    const agentId = await createAgent(page, 'Ledger agent for journey 19', { skillIds: ['bot-management'] });

    const readiness = await mockTradingReadiness(page, agentId);
    readiness.setReady(CONNECTION_ID);

    // Stub the presentation endpoint with the deterministic ledger fixture.
    await page.route(
      new RegExp(`/api/agents/${agentId}/capabilities/trading/presentation`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(presentationFixture(CONNECTION_ID)),
        });
      },
    );

    await page.goto(`/agents/${agentId}/capabilities/trading`);
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 10_000 });

    // ── P&L summary tiles ──────────────────────────────────────────────────
    await expect(page.getByText('1 of 2')).toBeVisible({ timeout: 10_000 });
    // Signs stay in the text (WCAG 1.4.1 — colour is not the only cue).
    await expect(page.getByText('+12.34')).toBeVisible();
    await expect(page.getByText('-20.00')).toBeVisible();

    // ── Trades table: three rows ───────────────────────────────────────────
    const tradesTable = page.locator('table').first();
    await expect(tradesTable).toBeVisible();
    await expect(tradesTable.locator('tbody tr')).toHaveCount(3);
    await expect(tradesTable.getByText('BTC')).toBeVisible();
    await expect(tradesTable.getByText('ETH')).toBeVisible();
    await expect(tradesTable.getByText('SOL')).toBeVisible();

    // ── P&L colour from the backend emphasis token (resilient) ─────────────
    const successColor = await tokenColor(page, '--color-success');
    const dangerColor = await tokenColor(page, '--color-danger');
    if (successColor && dangerColor && successColor !== dangerColor) {
      const winCell = tradesTable.getByText('+12.34');
      const lossCell = tradesTable.getByText('-20.00');
      await expect(winCell).toHaveCSS('color', successColor);
      await expect(lossCell).toHaveCSS('color', dangerColor);
    } else {
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'Theme tokens --color-success/--color-danger not resolvable; skipped colour assertion.',
      });
    }

    // ── Collapsed history expands on click ─────────────────────────────────
    const decisions = page.locator('details', { has: page.getByText('Decisions', { exact: true }) }).first();
    await expect(decisions).toBeVisible();
    expect(await decisions.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await decisions.locator('summary').click();
    expect(await decisions.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(decisions.getByText('Open long')).toBeVisible();

    const fills = page.locator('details', { has: page.getByText('Fills', { exact: true }) }).first();
    await expect(fills).toBeVisible();
    expect(await fills.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await fills.locator('summary').click();
    expect(await fills.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  });
});
