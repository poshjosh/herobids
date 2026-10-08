# Local Stripe Webhook Testing

How to test Stripe Checkout + webhooks locally, and the specific failure modes
that look like app bugs but aren't.

## Quick start

```sh
scripts/shell/run/dev-with-stripe-webhook.sh
```

This starts `stripe listen`, writes the printed signing secret into
`STRIPE_WEBHOOK_SECRET` in `.env`, and stays running in the foreground
(forwarding events to `localhost:3000/billing/webhook/stripe`). Leave it
running in its own terminal for the whole session — closing it (even
accidentally) stops webhook delivery with no error on either side.

After it prints a **new** secret (the value changes every time `stripe
listen` restarts), recreate the API container so it picks up the change:

```sh
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d api
```

`docker compose restart api` is **not** enough — see below.

## Choosing webhook events

Only these event types are handled by
`apps/api/src/billing/stripe-provider.ts`. Anything else Stripe sends is
ignored (200, no-op), so there's no need to filter for it:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Payload style: use **Snapshot** (full object payloads, versioned), not Thin.
Managed Payments and the rest of the billing code assume snapshot payloads
and a pinned `Stripe-Version`.

## Failure modes that look like app bugs but aren't

### 1. Stripe CLI authenticated to the wrong account/sandbox

`stripe login` / `stripe switch` can authenticate the CLI to a **different**
Stripe sandbox than the one your `STRIPE_SECRET_KEY` belongs to — even if
your browser tab looks like it's on the right account. Each sandbox has its
own `acct_...` ID; they are isolated environments, not views of the same
data.

**Symptom:** Checkout completes fine, subscriptions are created successfully
on Stripe's side, but no webhook ever arrives locally. No errors anywhere —
`stripe listen` sits at "Ready!" forever with nothing forwarded.

**How to confirm:**

```sh
stripe whoami
# compare the acct_... shown here against the account your key belongs to:
curl -s https://api.stripe.com/v1/account -u "$STRIPE_SECRET_KEY:" | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['id'])"
```

If the two `acct_...` IDs differ, the CLI is on the wrong account.

**Fix:**

```sh
stripe switch              # interactive picker — only shows ALREADY authorized accounts
stripe login                # if the right account isn't in the list, authorize it
                             # (watch the browser's account picker before approving —
                             # it can default to the wrong account/sandbox)
stripe switch acct_xxxxxxx  # once authorized, select it
```

### 2. `docker compose restart` does not reload `.env`

The `api`/`worker` services use `env_file: .env` in `docker-compose.yaml`.
Compose only reads `env_file` at **container creation**, not on `restart`.
If you change `.env` (e.g. a new `STRIPE_WEBHOOK_SECRET`) and run
`docker compose restart api`, the container keeps its old environment.

**Symptom:** Webhook requests arrive (visible in `stripe listen`'s log and
the API's request logs) but every one gets a 400 — signature verification
fails because the container is still checking against the previous secret.

**Fix:** recreate, don't restart:

```sh
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d api
```

Confirm the container actually has the new value:

```sh
docker compose exec api printenv | grep STRIPE_WEBHOOK_SECRET
grep STRIPE_WEBHOOK_SECRET .env
# these two must match
```

### 3. `stripe listen --events ... --all-snapshot` together forward nothing

`--events <list>` and `--all-snapshot` are mutually exclusive subscription
modes in the Stripe CLI. Passing both does not forward the union — it
silently results in nothing being forwarded, with no error.

**Fix:** use `--all-snapshot` alone. The webhook route already ignores
event types it doesn't handle, so there's no need to filter at the CLI
level.

### 4. Checkout redirects to a 404 (wrong port)

If `AUTH_FRONTEND_ORIGIN` and the actual port the `web` dev server is
published on disagree, Stripe's `success_url`/`cancel_url` redirect lands on
whatever else is listening on the stale port (often the API's own 404
handler, which looks like `Route GET:/billing?session=success not found`).

This project runs two different local topologies with different web ports:

- Standalone herobids (`reset-and-run.sh`): web on `:8080` (the default).
- Cross-stack with traderton (`reset-and-run-xstack.sh`): web on `:8090`,
  because `:8080` is reserved for the traderton boundary. This script
  `export`s `WEB_PORT=8090` itself for the `docker compose` invocations it
  runs — **do not** hardcode `WEB_PORT` into `.env` to "fix" this. `.env` is
  shared across both topologies; hardcoding a port there breaks whichever
  topology didn't set it.

**Fix:** re-run the bring-up script for whichever topology you're using
(`reset-and-run.sh` or `reset-and-run-xstack.sh`) rather than hand-patching
individual containers — it sets `WEB_PORT` consistently for every service
that needs it.

## Replaying a Stripe event

If you need to confirm a specific event would now be delivered (e.g. after
fixing one of the above), the simplest option is a synthetic trigger rather
than trying to resend a historical event by ID (the CLI's resend command
expects a notification ID, not the event ID shown in the dashboard/API, and
is easy to get wrong):

```sh
stripe trigger checkout.session.completed
```

Watch the `stripe listen` terminal for the forwarded event and the API's
response code.
