/**
 * Journey 13: AI Agents setup card (removed).
 *
 * The quick trading setup card was removed from AI Agents, so this journey is
 * skipped until a journey covers adding trading from an agent's Capabilities.
 */

import { test } from '@playwright/test';

test.describe('Journey 13: AI Agents setup card UI flow', () => {
  test('new user completes guided trading setup from AI Agents', async () => {
    // The setup card was removed; trading is now added from an agent's Capabilities.
    test.skip(true, 'Setup card removed; the Capabilities trading flow has no E2E journey yet');
  });
});
