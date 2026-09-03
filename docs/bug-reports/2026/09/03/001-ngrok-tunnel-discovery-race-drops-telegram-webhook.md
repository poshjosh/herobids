# Bug Report: ngrok tunnel-discovery race silently drops Telegram webhook registration

- **Status:** OPEN (diagnosed, fix not yet applied)
- **Severity:** Medium
- **Date:** 2026-09-03
- **Discovered By:** Investigating why Telegram messages sent to agents produced no delivery note, no wake, and no response on a local `docker compose` stack started via `scripts/shell/run/reset-and-run.sh`.
- **Summary:** `scripts/shell/tests/setup-local-telegram-webhook.sh` has a startup race between ngrok's local web API (`127.0.0.1:4040`) becoming reachable and the tunnel actually being registered. The script's readiness loop only waits for the `4040` API to respond, then performs tunnel discovery **exactly once with no retry**. ngrok's web API comes up ~400–600ms *before* the tunnel is listed, so the single discovery call can observe `{"tunnels":[]}`, the jq selector returns empty, and the script aborts with `Could not discover ngrok tunnel URL for localhost:3000`. `reset-and-run.sh` swallows this failure (`|| log "WARNING: ngrok setup failed..."`), so the stack proceeds with **no Telegram webhook registered**. Inbound Telegram messages then queue on Telegram's servers (`getWebhookInfo.url = ""`, `pending_update_count > 0`) and never reach the agent runtime. The failure is timing-dependent, which is why it works on some runs and fails on others ("worked 2 days ago").

---

## Symptoms (as observed)

- User sends a Telegram message to the bot for a running agent → no "Delivered to <agent>." reply, no agent wake, no response.
- `getWebhookInfo` returns `{"ok":true,"result":{"url":"","has_custom_certificate":false,"pending_update_count":2}}` — no webhook registered, messages queued.
- API access logs show **zero** `POST /telegram/webhook` hits during the affected window (Telegram never called in).
- Agent runtimes are healthy and heartbeating; `agent_messages` contains only tick/heartbeat machinery, no `user.message`; `agent:outbound:<id>` Redis streams contain no `user.message` entry.
- `reset-and-run.sh` console output at the failure:

  ```
  [→] Waiting for ngrok tunnel to be ready...
  [✗] Could not discover ngrok tunnel URL for localhost:3000
  [2026-09-03 17:58:36] WARNING: ngrok setup failed (stack is still usable without Telegram webhook)
  ```

---

## Root Cause

`scripts/shell/tests/setup-local-telegram-webhook.sh`, Step 1 (ngrok tunnel), lines ~172–192:

```bash
# Wait for ngrok API to become available
info "Waiting for ngrok tunnel to be ready..."
for i in $(seq 1 15); do
  sleep 1
  if curl -sS --max-time 3 "${NGROK_API}" > /dev/null 2>&1; then
    break                       # <-- breaks as soon as 4040 RESPONDS
  fi
  if [[ $i -eq 15 ]]; then
    fail "ngrok did not become ready within 15 seconds"
  fi
done

# Read the tunnel URL from the API  (runs EXACTLY ONCE, no retry)
run_curl_into NGROK_RESPONSE "ngrok tunnel discovery" -sS --max-time 5 "${NGROK_API}"
TUNNEL_URL=$(echo "$NGROK_RESPONSE" | jq -r '.tunnels[] | select(.config.addr | test("localhost:3000$")) | .public_url')
if [[ -z "$TUNNEL_URL" ]]; then
  fail "Could not discover ngrok tunnel URL for localhost:3000"
fi
```

The readiness check verifies only that the **ngrok web API endpoint** answers, not that a **tunnel is listed**. ngrok starts its web service (`obj=web addr=127.0.0.1:4040`) before it emits `started tunnel`, so there is a short window in which `GET /api/tunnels` returns HTTP 200 with an empty `tunnels` array. Because discovery runs a single time immediately after the loop breaks, a discovery call landing in that window yields an empty selection and the script aborts.

The bug is **not** in the jq selector or a format/version mismatch. With the tunnel established, ngrok reports `config.addr = "http://localhost:3000"`, which `test("localhost:3000$")` matches correctly.

### Reproduction (measured on the affected machine)

ngrok 3.39.10, valid config, authtoken present. Polling `GET http://localhost:4040/api/tunnels` as fast as possible immediately after `ngrok http 3000 --log=stdout &`:

```
poll #1: api_up=no
poll #2: api_up=yes tunnels=0      <-- 4040 up, tunnel NOT yet registered
poll #3: api_up=yes tunnels=0
poll #4: api_up=yes tunnels=1      <-- tunnel registered (~0.8s)
```

Corresponding ngrok log ordering:

```
lvl=info msg="starting web service" obj=web addr=127.0.0.1:4040
lvl=info msg="tunnel session started" obj=tunnels.session
lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:3000 url=https://<sub>.ngrok-free.dev
```

The script's readiness loop breaks at the equivalent of poll #2, then its single discovery call can observe `tunnels: []`. Whether the run fails depends on where in the ~400–600ms window that one call lands — hence the intermittency.

---

## Impact

- Local/dev Telegram inbound is intermittently and silently disabled after `reset-and-run.sh`. The stack looks healthy, agents run, but no Telegram message can reach an agent.
- Because `reset-and-run.sh` treats ngrok failure as a non-fatal warning, there is no hard signal; the operator only notices when messages silently do nothing.
- No production runtime impact (this is local tooling), but it costs significant debugging time and masks the real state of the Telegram ingress.

---

## Suggested Fix (not yet applied)

Primary — make discovery wait for an actual tunnel, not just for the API to answer. Replace the "API responds" break + single discovery with a bounded retry that polls until the selector yields a non-empty `public_url`:

```bash
info "Waiting for ngrok tunnel to be ready..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  NGROK_RESPONSE=$(curl -sS --max-time 3 "${NGROK_API}" 2>/dev/null || true)
  if [[ -n "$NGROK_RESPONSE" ]]; then
    TUNNEL_URL=$(echo "$NGROK_RESPONSE" \
      | jq -r '.tunnels[]? | select(.public_url | startswith("https")) | .public_url' \
      | head -n1)
    [[ -n "$TUNNEL_URL" ]] && break
  fi
  sleep 1
done
[[ -n "$TUNNEL_URL" ]] || fail "Could not discover ngrok tunnel URL for localhost:3000 within 30s"
```

Secondary hardening:
- Prefer selecting the first `https` `public_url` over matching `config.addr`, so a future ngrok addr-format change (e.g. `127.0.0.1` vs `localhost`, scheme prefix) cannot silently reintroduce this.
- Consider making `reset-and-run.sh` surface the ngrok failure more loudly (it is currently downgraded to a WARNING), or add a post-condition check that `getWebhookInfo.url` is non-empty when a bot token is configured.

---

## Related / Adjacent Issues (out of scope for this fix, worth tracking)

1. **`TELEGRAM_WEBHOOK_URL` clobber risk.** `.env` pins `TELEGRAM_WEBHOOK_URL=http://localhost:3000/api/telegram/webhook` (a URL Telegram cannot reach). The setup script's Step 5 warns that a worker restart with this value set would overwrite a good tunnel registration. `.env.ops.dev` (the file `reset-and-run.sh` sources) does not set it, so the reset flow is currently safe — but the stale value in `.env` is a latent footgun.
2. **Webhook path mismatch.** The setup script registers `${TUNNEL_URL}/telegram/webhook`, while `.env`'s `TELEGRAM_WEBHOOK_URL` uses `/api/telegram/webhook`. The route the API actually serves should be confirmed and the two sources reconciled.

---

## Verification of the diagnosis (this session)

- `getWebhookInfo` before fix: `url: ""`, `pending_update_count: 2` (the two undelivered messages).
- Reproduced the empty-tunnel window directly (poll table above).
- Ran `scripts/shell/tests/setup-local-telegram-webhook.sh --env-file .env.ops.dev` manually; on a run that won the race it registered successfully. Post-registration `getWebhookInfo`: `url: https://<sub>.ngrok-free.dev/telegram/webhook`, `pending_update_count: 0`; API logs then showed two `POST /telegram/webhook` hits (the previously queued updates delivered).
- Note: the current 4 agents (`thyper`, `t1inch`, `tintel`, `security-auditor`) are all `stopped`, so the delivered messages had no running agent to route to — expected per the plain-text routing in `telegramWebhookHandler`.

---

## Files Implicated

- `scripts/shell/tests/setup-local-telegram-webhook.sh` — readiness loop + single-shot tunnel discovery (root cause).
- `scripts/shell/run/reset-and-run.sh` — swallows the ngrok failure as a non-fatal warning (masks the problem).
