/**
 * Journey 13: AI Agents guided setup card — full UI flow.
 *
 * Verifies that a new user can:
 * 1. See the quick trading setup card on AI Agents.
 * 2. Open the setup form by clicking the CTA button.
 * 3. Fill in provider details and secrets, then submit.
 * 4. See the success banner with the account label and provider.
 * 5. Dismiss the banner and return to the setup card.
 */

import { test } from '@playwright/test';

test.describe('Journey 13: AI Agents setup card UI flow', () => {
  test('new user completes guided trading setup from AI Agents', async () => {
    // The setup card ("Connect AI agent to external platform") was removed
    // from the AI Agents page — trading setup now happens inline during agent
    // creation (covered by Journey 14: Create Agent inline trading setup).
    test.skip(true, 'Setup card removed from agents page; inline flow covered by Journey 14');
  });
});
