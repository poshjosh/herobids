#!/usr/bin/env bash
# Run this if you want to test stripe webhook on local
# Leave it running as it listens for in-coming webhook
# Requires: stripe-cli
# Get a webhook for use in local development, save it to ENV_FILE
set -euo pipefail

PORT="${API_PORT:-3000}"
ENV_FILE=".env"

# Ensure the Stripe CLI is authenticated. `stripe login` always opens a
# browser and blocks on confirmation, so only call it when not already
# logged in. `stripe config --list` always exits 0 even with no account
# configured, so check for an actual account_id in the config instead
# (newer CLI versions store credentials under a profile, not a bare
# "*_api_key" field).
if ! stripe config --list 2>/dev/null | grep -q 'account_id'; then
  echo "Stripe CLI not authenticated — running 'stripe login'..."
  stripe login
fi

# --events and --all-snapshot are mutually exclusive subscription modes in the
# Stripe CLI (confirmed via `stripe listen --help`) — passing both silently
# forwards nothing. Use --all-snapshot alone; the webhook route already
# ignores event types it doesn't handle (see stripe-provider.ts), so there's
# no need to filter here.
stripe listen \
  --forward-to "localhost:${PORT}/billing/webhook/stripe" \
  --all-snapshot \
  > /tmp/stripe-listen.log 2>&1 &
STRIPE_PID=$!
trap "kill $STRIPE_PID 2>/dev/null || true" EXIT

# Wait for the secret to appear in the log, then extract it
for i in $(seq 1 20); do
  SECRET=$(grep -o 'whsec_[a-zA-Z0-9]*' /tmp/stripe-listen.log | head -1 || true)
  [[ -n "$SECRET" ]] && break
  sleep 0.5
done

if [[ -z "${SECRET:-}" ]]; then
  echo "Failed to get webhook secret from stripe listen"
  exit 1
fi

# Update .env in place — replace the line if present, append it if not.
if grep -q '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE"; then
  sed -i.bak "s/^STRIPE_WEBHOOK_SECRET=.*/STRIPE_WEBHOOK_SECRET=${SECRET}/" "$ENV_FILE"
else
  echo "STRIPE_WEBHOOK_SECRET=${SECRET}" >> "$ENV_FILE"
fi
echo "STRIPE_WEBHOOK_SECRET set to ${SECRET}"
echo "Restart the API so it picks up the new STRIPE_WEBHOOK_SECRET (e.g. docker compose restart api)."
echo "Leaving 'stripe listen' running in the foreground — forwarding events to localhost:${PORT}/billing/webhook/stripe"
echo "Press Ctrl+C to stop."

# Keep the tunnel alive. Without this the script reaches EOF, bash exits,
# the EXIT trap fires, and stripe listen gets killed immediately —
# tearing the tunnel down right after setting it up.
wait "$STRIPE_PID"
