# Phase 4 Stage C Operator Checklist

**Date:** 2026-05-30

**Related plan:** [010-phase-4-live-rollout-plan.md](010-phase-4-live-rollout-plan.md)

**Related PR sequence:** [011-phase-4-live-rollout-pr-sequence.md](011-phase-4-live-rollout-pr-sequence.md)

**Current rollout status:** [015-phase-4-live-rollout-status-2026-05-30.md](015-phase-4-live-rollout-status-2026-05-30.md)

## Purpose

This is the tight operator checklist for the missing Stage C proofs:

- forced restart and recovery
- linked-credential rotation
- post-restart audit and live-status evidence capture

It is grounded in the current API surface, not the older Stage C helper script alone.

## Why This Checklist Exists

The current helper scripts are useful references, but parts of the Stage C flow have drifted from the live API:

- `scripts/shell/rollout/rollout-stage-c.sh` calls `PUT /credentials/:id/rotate`, but the current route is `POST /credentials/:id/rotate`
- `scripts/shell/rollout/rollout-stage-c.sh` calls `/reconciliation`, but the current route is `GET /instances/:id/reconciliation-events`
- `scripts/shell/rollout/rollout-stage-c.sh` expects `GET /venue-accounts/:id`, but the current API only exposes `GET /venue-accounts`
- `scripts/shell/rollout/rollout-monitor.sh` is still useful for fills/status/reconciliation, but its internal `liveEvents` field is not authoritative because `GET /instances/:id/live-status` returns `recentLiveEvents`

Until those helpers are updated, this checklist is the authoritative Stage C runbook.

## Preconditions

- One bounded Stage B live instance exists and is intended to remain the only live exposure during this check.
- API and worker are already running.
- The instance is expected to run in `execution.mode: live`.
- The operator has the linked Hyperliquid credential material available for rotation.
- `jq` is available locally for concise response inspection.

The API/worker processes must already be running with the operator-side environment they need, including the credential encryption key. This checklist does not restart the services themselves.

## Shell Setup

Use one shell session for the checklist.

```bash
export API_PORT="${API_PORT:-3000}"
export API_URL="http://localhost:${API_PORT}"
export INSTANCE_ID="<stage-b-instance-id>"

export ROTATE_API_KEY="${HYPERLIQUID_API_KEY:-}"
export ROTATE_SECRET="${HYPERLIQUID_SECRET:-}"
export ROTATE_WALLET_ADDRESS="${HYPERLIQUID_ACCOUNT_ADDRESS:-}"
```

If you are verifying rotation workflow rather than changing keys, it is acceptable to rotate to the same secrets blob currently in use. Include `walletAddress` so the replacement blob stays complete.

## 1. Baseline Capture

Confirm the API is up and capture the current live state before any restart or rotation.

```bash
curl -sf "$API_URL/health" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/live-readiness" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=10" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/reconciliation-events?limit=10" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&limit=20" | jq '.events | map({type, createdAt})'
```

Record these baseline fields:

- `status` from `GET /instances/:id`
- `readinessState` from `GET /instances/:id/live-readiness`
- `lastReconciliation.timestamp` from `GET /instances/:id/live-status`
- count of `recentFills`
- count of `slippageAlerts`

Do not start Stage C if any of these are already true:

- `readinessState` is `blocked`
- instance `status` is `crashed`
- the latest reconciliation output already shows unexplained drift you have not triaged

## 2. Optional Watch Window

You can keep a live monitor running in another shell during the restart and rotation steps.

```bash
./scripts/shell/rollout/rollout-monitor.sh "$INSTANCE_ID" --interval 5
```

Treat this helper as observational only. The authoritative evidence still comes from explicit API snapshots and journal queries.

## 3. Forced Restart And Recovery

Capture the pre-restart reconciliation timestamp first.

```bash
export PRE_RECON_TS="$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=10" | jq -r '.lastReconciliation.timestamp // "none"')"
echo "$PRE_RECON_TS"
```

Stop and restart the instance.

```bash
curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/stop" | jq
sleep 3
curl -sf -X POST "$API_URL/instances/$INSTANCE_ID/start" | jq
```

Poll until the instance is both running and re-armed.

```bash
until [[ "$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-readiness" | jq -r '.readinessState')" == "armed" ]]; do
  date '+%H:%M:%S waiting for readiness=armed'
  sleep 5
done

curl -sf "$API_URL/instances/$INSTANCE_ID/live-readiness" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=10" | jq
```

Check that reconciliation ran after restart.

```bash
export POST_RECON_TS="$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=10" | jq -r '.lastReconciliation.timestamp // "none"')"
printf 'pre=%s\npost=%s\n' "$PRE_RECON_TS" "$POST_RECON_TS"
```

Check for recovery events.

```bash
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.completion_recovered&limit=10" | jq
```

Restart proof passes when all of the following are true:

- `readinessState` returns to `armed`
- `GET /instances/:id/live-status` shows a reconciliation timestamp after the restart window
- instance `status` is not `crashed`
- if the instance had unresolved live state before restart, `order.completion_recovered` is present in the journal

If there were no unresolved live orders or plans before restart, a zero `order.completion_recovered` count is acceptable. Record that explicitly rather than treating it as implicit success.

## 4. Resolve The Linked Credential ID

The instance record contains `venueAccountId`. The current API does not expose `GET /venue-accounts/:id`, so resolve the credential by filtering the venue-account list.

```bash
export VENUE_ACCOUNT_ID="$(curl -sf "$API_URL/instances/$INSTANCE_ID" | jq -r '.venueAccountId')"
export CREDENTIAL_ID="$(curl -sf "$API_URL/venue-accounts" | jq -r --arg id "$VENUE_ACCOUNT_ID" '.venueAccounts[] | select(.id == $id) | .credentialId')"

printf 'venueAccountId=%s\ncredentialId=%s\n' "$VENUE_ACCOUNT_ID" "$CREDENTIAL_ID"
```

Stop here if `CREDENTIAL_ID` is empty.

## 5. Rotate The Linked Credential

Rotate through the current API route and capture the full response.

```bash
curl -sf -X POST "$API_URL/credentials/$CREDENTIAL_ID/rotate" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg apiKey "$ROTATE_API_KEY" \
    --arg secret "$ROTATE_SECRET" \
    --arg walletAddress "$ROTATE_WALLET_ADDRESS" \
    '{secrets:{apiKey:$apiKey, secret:$secret, walletAddress:$walletAddress}}')" | tee /tmp/herobids-stage-c-rotate.json | jq
```

Inspect the response.

```bash
jq '{status, credentialId, dependentTradingInstanceIds, restartedTradingInstanceIds, restartErrorCode, restartError}' /tmp/herobids-stage-c-rotate.json
```

Rotation proof passes only if all of the following are true:

- `status` is `rotated`
- `dependentTradingInstanceIds` contains the live instance when that instance was running at rotation time
- `restartedTradingInstanceIds` contains the live instance
- `restartErrorCode` is absent

If `restartErrorCode` is present, treat Stage C as blocked even though the credential row itself was updated successfully.

## 6. Verify Restart-Time Reload After Rotation

Rotation should trigger restart jobs for running dependents. Poll until the instance is armed again.

```bash
until [[ "$(curl -sf "$API_URL/instances/$INSTANCE_ID/live-readiness" | jq -r '.readinessState')" == "armed" ]]; do
  date '+%H:%M:%S waiting for post-rotation readiness=armed'
  sleep 5
done

curl -sf "$API_URL/instances/$INSTANCE_ID/live-readiness" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=10" | jq
```

Capture audit evidence for rotation and decrypt.

```bash
curl -sf "$API_URL/journal?type=credential.rotated&limit=20" | jq --arg cred "$CREDENTIAL_ID" '.events | map(select(.payload.credentialId == $cred))'
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=credential.decrypted&limit=20" | jq
```

Reload proof passes when:

- a `credential.rotated` event exists for the credential ID
- a `credential.decrypted` event exists for the instance after the rotation window
- the instance returns to `readinessState: armed`

The durable API does not expose private-stream state directly. Use the re-armed readiness state, reconciliation progress, and absence of crash as the restart-time evidence currently available through the API.

## 7. Verify Post-Rotation Live Use And Reconciliation Evidence

Leave the instance running long enough to observe at least one post-rotation live cycle.

Capture these views:

```bash
curl -sf "$API_URL/instances/$INSTANCE_ID/live-status?limit=20" | jq
curl -sf "$API_URL/instances/$INSTANCE_ID/reconciliation-events?limit=20" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=credential.used&limit=20" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.submitted_to_venue&limit=20" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.acknowledged&limit=20" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=order.fill_confirmed_from_stream&limit=20" | jq
curl -sf "$API_URL/journal?tradingInstanceId=$INSTANCE_ID&type=live.slippage_alert&limit=20" | jq
```

At minimum, record:

- latest reconciliation result and timestamp
- whether `credential.used` was observed after rotation
- whether a live order was submitted and acknowledged after rotation
- whether any fills were confirmed from stream after rotation
- whether any slippage alerts were emitted

If the market window does not produce a post-rotation live order, Stage C is not fully closed. Record the restart and rotation evidence as complete, and the post-rotation live-use proof as still pending.

## 8. Evidence Bundle To Save

Save the following into the follow-up Stage C results note:

- instance ID
- restart start time and re-armed time
- pre- and post-restart reconciliation timestamps
- rotation response JSON
- `credential.rotated` evidence
- `credential.decrypted` evidence after rotation
- `credential.used` evidence after rotation, or an explicit note that no post-rotation order occurred yet
- latest reconciliation snapshot after the rotation window
- current `live-status` snapshot including fills and slippage alerts

## Blockers

Treat Stage C as failed or incomplete if any of the following happens:

- instance remains `blocked` or transitions to `crashed`
- reconciliation does not resume after restart
- rotation response includes `restartErrorCode`
- no post-rotation `credential.decrypted` event appears for the instance
- unexplained or repeated drift appears and is not understood
- slippage alerts repeat at a level the operator cannot justify

## Completion Rule

Stage C is complete only when all three proof classes are recorded:

- restart and recovery
- linked-credential rotation plus restart-time reload
- post-rotation audit/live-status evidence

Until then, keep live scope bounded as described in [015-phase-4-live-rollout-status-2026-05-30.md](015-phase-4-live-rollout-status-2026-05-30.md).